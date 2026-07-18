import asyncio
import logging
from typing import List, Optional

import discord

from config import BotConfig


class BotInstance:
    """
    Represents a single Discord bot instance with robust voice connection management.
    
    Key features:
    - VC Persistence: Remembers the last voice channel the bot was moved to by an admin.
      On app restart, resets to the configured startup VC.
    - Drag Behavior: If an admin drags the bot to another VC, it stays there and updates
      its internal target. It does NOT reconnect back to the original VC.
    - Disconnect Recovery: On disconnect (network, gateway, etc.), automatically rejoins
      the LAST KNOWN voice channel (the last admin-moved channel, or startup VC).
    - Health Watchdog: Runs every 5-10 seconds, validates voice connection state,
      detects stale/disconnected/invalid VoiceClients, and recovers automatically.
    - Safe Reconnection: Prevents concurrent reconnect attempts, handles stale VoiceClients,
      uses timeouts, and avoids race conditions.
    """

    # Health check interval in seconds (5-10 seconds as required)
    HEALTH_CHECK_INTERVAL = 7
    
    # Timeout for voice connection operations
    CONNECT_TIMEOUT = 15.0
    DISCONNECT_TIMEOUT = 5.0
    
    # Maximum time to wait for voice client to fully disconnect
    VOICE_CLEANUP_TIMEOUT = 5.0
    
    # Reconnect lock timeout - prevents deadlock if reconnect hangs
    RECONNECT_LOCK_TIMEOUT = 30.0

    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.logger = logging.getLogger(config.name)

        # Configure intents - need voice_states for voice_state_update events
        self._intents = discord.Intents.default()
        self._intents.voice_states = True

        # The configured startup VC - this is the default on app restart
        self._startup_vc_id: int = config.vc_id
        
        # The current target VC - starts as startup VC, updates when admin moves bot
        # This persists across disconnects but NOT across app restarts
        self._target_vc_id: int = config.vc_id

        self.client: Optional[discord.Client] = None
        self._ready_event = asyncio.Event()
        self._stopped = False
        self._task: Optional[asyncio.Task] = None
        
        # Reconnection lock - prevents concurrent reconnect attempts
        self._reconnect_lock = asyncio.Lock()
        
        # Health check task reference for proper cleanup
        self._health_task: Optional[asyncio.Task] = None
        
        # Reconnect backoff
        self._retry_delay = 5
        self._max_retry_delay = 60

        # Build the discord client with event handlers
        self.client = self._build_client()

    def _build_client(self) -> discord.Client:
        """Build and configure the Discord client with event handlers."""
        client = discord.Client(intents=self._intents)

        @client.event
        async def on_ready():
            self.logger.info("Connected to Discord")
            self._retry_delay = 5  # Reset backoff on successful connection
            self._ready_event.set()
            # Initial join - will connect to _target_vc_id (which is startup VC on first run)
            await self._join_target_vc()

        @client.event
        async def on_voice_state_update(member: discord.Member, before: discord.VoiceState, after: discord.VoiceState):
            if member != client.user:
                return
            
            await self._handle_voice_state_update(member, before, after)

        @client.event
        async def on_disconnect():
            self.logger.warning("Discord gateway disconnected")
            self._ready_event.clear()

        @client.event
        async def on_resumed():
            self.logger.info("Discord gateway resumed")
            self._ready_event.set()

        @client.event
        async def on_error(event, *args, **kwargs):
            self.logger.exception(f"Error in event {event}")

        return client

    async def _handle_voice_state_update(self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState) -> None:
        """
        Handle voice state updates for the bot user.
        
        Key behaviors:
        - Admin drags bot to new VC (after.channel exists and != _target_vc_id): 
          Update _target_vc_id, STAY in new channel, do NOT reconnect
        - Bot disconnected (after.channel is None): 
          Reconnect to _target_vc_id (last known channel)
        - Bot moved by other means (e.g., Discord bug, channel deleted): 
          Reconnect to _target_vc_id
        """
        if not self._ready_event.is_set():
            return

        self.logger.debug(f"Voice state update: before.channel={before.channel.id if before.channel else None}, after.channel={after.channel.id if after.channel else None}, target={self._target_vc_id}")

        # Case 1: Bot was disconnected (kicked, network issue, channel deleted, etc.)
        if after.channel is None:
            self.logger.warning("Bot disconnected from voice channel")
            # Reconnect to LAST KNOWN target channel (not necessarily startup VC)
            await self._schedule_reconnect("disconnected")
            return

        # Case 2: Bot was moved to a different channel (admin drag or Discord reassignment)
        if after.channel.id != self._target_vc_id:
            # Update target to the new channel and STAY - do NOT reconnect
            old_target = self._target_vc_id
            self._target_vc_id = after.channel.id
            self.logger.info(f"Bot moved from VC {old_target} to VC {self._target_vc_id}. Updated reconnect target.")
            return

        # Case 3: Bot is in the correct target channel - nothing to do
        self.logger.debug("Bot is in correct target VC")

    async def _schedule_reconnect(self, reason: str) -> None:
        """Schedule a reconnection attempt. Uses lock to prevent concurrent reconnects."""
        if self._stopped or not self._ready_event.is_set():
            return
        
        # Try to acquire reconnect lock without blocking - if another reconnect is in progress, skip
        if self._reconnect_lock.locked():
            self.logger.debug(f"Reconnect already in progress, skipping ({reason})")
            return
        
        # Schedule the reconnect task
        asyncio.create_task(self._reconnect_with_lock(reason))

    async def _reconnect_with_lock(self, reason: str) -> None:
        """Perform reconnection with lock to prevent concurrent attempts."""
        async with self._reconnect_lock:
            # Double-check after acquiring lock
            if self._stopped or not self._ready_event.is_set():
                return
            
            self.logger.info(f"Reconnecting due to: {reason}, target VC: {self._target_vc_id}")
            await self._do_join_target_vc()

    async def _join_target_vc(self) -> bool:
        """
        Connect to the current target voice channel (_target_vc_id).
        
        This is the CORE voice connection logic with:
        - Proper validation of existing VoiceClient
        - Stale VoiceClient cleanup
        - Connection timeout
        - Race condition prevention via lock
        - Robust exception handling
        
        Returns True on success, False on failure.
        """
        # Quick check - if already in correct channel with valid connection, do nothing
        if await self._is_connected_to_target():
            self.logger.debug("Already connected to target VC")
            return True

        # Use lock to prevent concurrent join attempts
        # Use a timeout to prevent deadlock
        try:
            await asyncio.wait_for(self._reconnect_lock.acquire(), timeout=self.RECONNECT_LOCK_TIMEOUT)
        except asyncio.TimeoutError:
            self.logger.error("Reconnect lock timeout - another operation may be stuck")
            return False
        
        try:
            return await self._do_join_target_vc()
        finally:
            self._reconnect_lock.release()

    async def _is_connected_to_target(self) -> bool:
        """Check if we have a valid, connected VoiceClient in the target channel.

        Uses only public discord.py APIs: voice.is_connected() and voice.channel.
        """
        if self.client is None or self.client.is_closed():
            return False
        
        guild = self.client.get_guild(self.config.guild_id)
        if guild is None:
            return False
        
        voice = guild.voice_client
        if voice is None:
            return False
        
        # Validate the voice client is actually connected and in the right channel
        if not voice.is_connected():
            return False
        
        if voice.channel is None or voice.channel.id != self._target_vc_id:
            return False
        
        return True

    async def _do_join_target_vc(self) -> bool:
        """Internal method to perform the actual voice channel join."""
        guild = self.client.get_guild(self.config.guild_id)
        if guild is None:
            self.logger.error(f"Guild {self.config.guild_id} not found")
            return False

        channel = guild.get_channel(self._target_vc_id)
        if channel is None or not isinstance(channel, discord.VoiceChannel):
            self.logger.error(f"Target voice channel {self._target_vc_id} not found or not a voice channel")
            return False

        # Check for existing voice client and clean up if needed
        existing_voice = guild.voice_client
        if existing_voice is not None:
            self.logger.debug(f"Found existing voice client in channel {existing_voice.channel.id if existing_voice.channel else 'None'}")
            
            # If already in correct channel and connected, we're good
            if existing_voice.is_connected() and existing_voice.channel and existing_voice.channel.id == self._target_vc_id:
                self.logger.debug("Already in target channel with valid connection")
                return True
            
            # Otherwise, clean up the stale connection
            self.logger.warning(f"Cleaning up stale voice client in channel {existing_voice.channel.id if existing_voice.channel else 'None'}")
            await self._cleanup_voice_client(existing_voice)
            
            # Wait for cleanup to complete
            await self._wait_for_voice_cleanup(guild)

        # Connect to target channel with timeout
        self.logger.info(f"Connecting to voice channel {self._target_vc_id} ({channel.name})")
        try:
            voice_client = await asyncio.wait_for(
                channel.connect(reconnect=True, timeout=self.CONNECT_TIMEOUT),
                timeout=self.CONNECT_TIMEOUT
            )
            self.logger.info(f"Successfully joined VC {self._target_vc_id} ({channel.name})")
            return True
        except asyncio.TimeoutError:
            self.logger.error(f"Connection to VC {self._target_vc_id} timed out after {self.CONNECT_TIMEOUT}s")
            # Cleanup any partial connection
            if guild.voice_client:
                await self._cleanup_voice_client(guild.voice_client)
            return False
        except discord.ClientException as e:
            self.logger.error(f"Discord client error connecting to VC: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Unexpected error connecting to VC: {e}")
            return False

    async def _cleanup_voice_client(self, voice_client: discord.VoiceClient) -> None:
        """Safely disconnect and clean up a voice client."""
        if voice_client is None:
            return
        
        try:
            if voice_client.is_connected():
                await asyncio.wait_for(voice_client.disconnect(force=True), timeout=self.DISCONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            self.logger.warning("Voice client disconnect timed out, forcing cleanup")
        except Exception as e:
            self.logger.debug(f"Error during voice client cleanup: {e}")

    async def _wait_for_voice_cleanup(self, guild: discord.Guild, timeout: float = VOICE_CLEANUP_TIMEOUT) -> None:
        """Wait for voice client to be fully cleaned up."""
        start = asyncio.get_event_loop().time()
        while guild.voice_client is not None:
            if asyncio.get_event_loop().time() - start > timeout:
                self.logger.warning("Voice cleanup timeout - voice client may be stuck")
                break
            await asyncio.sleep(0.1)

    # =====================================================================
    # HEALTH WATCHDOG - Production-grade voice connection monitoring
    # =====================================================================

    async def _health_check_loop(self) -> None:
        """
        Production-grade health watchdog.
        
        Runs every 5-10 seconds and detects:
        - Missing VoiceClient
        - Disconnected VoiceClient
        - Stale VoiceClient (connected but wrong channel)
        - Closed voice websocket
        - Invalid connection state
        
        Automatically recovers without spamming reconnect attempts.
        """
        self.logger.debug("Health check loop started")
        
        while not self._stopped:
            try:
                await asyncio.sleep(self.HEALTH_CHECK_INTERVAL)
            except asyncio.CancelledError:
                break
            
            if self._stopped or not self._ready_event.is_set():
                continue

            try:
                await self._perform_health_check()
            except Exception as e:
                self.logger.error(f"Health check error: {e}")

        self.logger.debug("Health check loop stopped")

    async def _perform_health_check(self) -> None:
        """Perform a single health check iteration.

        Uses only public discord.py APIs. Detects:
        - Missing guild
        - Missing VoiceClient (disconnected)
        - VoiceClient not connected
        - VoiceClient in wrong channel (update target instead of reconnect)
        """
        guild = self.client.get_guild(self.config.guild_id)
        if guild is None:
            self.logger.warning("Health check: Guild not found")
            await self._schedule_reconnect("guild not found")
            return

        voice = guild.voice_client
        
        # Check 1: No voice client at all
        if voice is None:
            self.logger.warning("Health check: No voice client")
            await self._schedule_reconnect("no voice client")
            return

        # Check 2: Voice client exists but not connected
        if not voice.is_connected():
            self.logger.warning("Health check: Voice client not connected")
            await self._schedule_reconnect("voice not connected")
            return

        # Check 3: Voice client in different channel
        # This means either an admin moved the bot (voice state event may be delayed)
        # or a stale connection after a move. In both cases, update the target to match
        # reality rather than disconnecting and reconnecting.
        if voice.channel is None or voice.channel.id != self._target_vc_id:
            old_target = self._target_vc_id
            self._target_vc_id = voice.channel.id if voice.channel else old_target
            self.logger.info(
                f"Health check: Voice client in channel {voice.channel.id if voice.channel else 'None'}, "
                f"updated target from {old_target} to {self._target_vc_id}"
            )
            return

        self.logger.debug(f"Health check OK: connected to VC {voice.channel.id}")

    # =====================================================================
    # LIFECYCLE MANAGEMENT
    # =====================================================================

    async def start(self) -> None:
        """Start the bot instance."""
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        """Main run loop with exponential backoff retry on disconnect."""
        while not self._stopped:
            self._health_task = None
            try:
                # Rebuild client for each connection attempt (clean state)
                # Reset the lock in case it was held when the previous client was closed
                self._reconnect_lock = asyncio.Lock()
                self.client = self._build_client()
                self._ready_event.clear()

                # Start health check task
                self._health_task = asyncio.create_task(self._health_check_loop())

                # Connect to Discord with auto-reconnect for gateway
                async with self.client:
                    await self.client.start(self.config.token, reconnect=True)
                    
            except discord.LoginFailure:
                self.logger.error("Invalid bot token. Will not retry.")
                self._stopped = True
            except asyncio.CancelledError:
                self.logger.info("Run loop cancelled")
                break
            except Exception as e:
                self.logger.error(f"Bot error: {e}")
            finally:
                # Cleanup health task
                if self._health_task is not None:
                    self._health_task.cancel()
                    try:
                        await self._health_task
                    except (asyncio.CancelledError, Exception):
                        pass
                self._health_task = None

            if not self._stopped:
                self.logger.info(f"Retrying in {self._retry_delay}s...")
                await asyncio.sleep(self._retry_delay)
                self._retry_delay = min(self._retry_delay * 2, self._max_retry_delay)

    async def stop(self) -> None:
        """Gracefully stop the bot instance."""
        self.logger.info("Stopping bot...")
        self._stopped = True
        
        # Cancel health check first
        if self._health_task is not None:
            self._health_task.cancel()
            try:
                await self._health_task
            except (asyncio.CancelledError, Exception):
                pass
        
        # Close Discord client
        if self.client and not self.client.is_closed():
            try:
                await self.client.close()
            except Exception as e:
                self.logger.debug(f"Error closing client: {e}")
        
        # Wait for run loop to finish
        if self._task is not None:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

        self.logger.info("Bot stopped")

    async def wait_until_ready(self) -> None:
        """Wait until the bot is connected and ready."""
        await self._ready_event.wait()


class BotManager:
    """Manages multiple bot instances."""
    
    def __init__(self) -> None:
        self.instances: List[BotInstance] = []

    def add_bot(self, config: BotConfig) -> BotInstance:
        """Add a new bot instance from config."""
        instance = BotInstance(config)
        self.instances.append(instance)
        return instance

    async def start_all(self) -> None:
        """Start all bot instances."""
        for instance in self.instances:
            await instance.start()

    async def wait_until_all_ready(self) -> None:
        """Wait until all bots are ready."""
        for instance in self.instances:
            await instance.wait_until_ready()

    async def stop_all(self) -> None:
        """Stop all bot instances gracefully."""
        await asyncio.gather(
            *[instance.stop() for instance in self.instances],
            return_exceptions=True,
        )

    async def run_forever(self) -> None:
        """Run all bots until stopped."""
        tasks = [instance._task for instance in self.instances if instance._task is not None]
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)
