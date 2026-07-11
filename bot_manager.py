import asyncio
import logging
from typing import List

import discord

from config import BotConfig


class BotInstance:
    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.logger = logging.getLogger(config.name)

        self._intents = discord.Intents.default()
        self._intents.voice_states = True

        self.client = self._build_client()
        self._ready_event = asyncio.Event()
        self._join_lock = asyncio.Lock()
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._retry_delay = 5

    def _build_client(self) -> discord.Client:
        client = discord.Client(intents=self._intents)

        @client.event
        async def on_ready():
            self._retry_delay = 5
            self._ready_event.set()
            self.logger.info("Connected")
            await self._join_voice()

        @client.event
        async def on_voice_state_update(member, before, after):
            if member != client.user:
                return
            if after.channel is None or after.channel.id != self.config.vc_id:
                self.logger.info("Reconnecting...")
                await self._join_voice()

        return client

    async def _join_voice(self) -> bool:
        """Connect to the configured voice channel. Returns True on success."""
        if self._join_lock.locked():
            return False

        async with self._join_lock:
            guild = self.client.get_guild(self.config.guild_id)
            if guild is None:
                self.logger.debug(f"Guild {self.config.guild_id} not found")
                return False

            channel = guild.get_channel(self.config.vc_id)
            if channel is None:
                self.logger.debug(f"Voice channel {self.config.vc_id} not found")
                return False

            voice = guild.voice_client
            if voice is not None:
                if voice.channel and voice.channel.id == self.config.vc_id:
                    return True
                try:
                    await voice.disconnect()
                except Exception:
                    pass
                for _ in range(30):
                    if guild.voice_client is None:
                        break
                    await asyncio.sleep(0.1)

            self.logger.info("Joining VC...")
            try:
                await channel.connect()
                self.logger.info("Joined VC")
                return True
            except Exception as e:
                self.logger.error(f"Error: {e}")
                return False

    async def _health_check_loop(self) -> None:
        """Periodically verify the voice connection and reconnect if needed."""
        while not self._stopped:
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                break

            if not self._ready_event.is_set() or self._stopped:
                continue

            try:
                reason = None
                guild = self.client.get_guild(self.config.guild_id)
                if guild is None:
                    reason = "guild not found"
                else:
                    voice = guild.voice_client
                    if voice is None:
                        reason = "no voice client"
                    elif not voice.is_connected():
                        reason = "voice not connected"
                    elif voice.channel is None or voice.channel.id != self.config.vc_id:
                        reason = "wrong channel"

                if reason:
                    self.logger.warning(f"Voice health check failed: {reason}")
                    if await self._join_voice():
                        self.logger.info("Successfully rejoined")
            except Exception as e:
                self.logger.error(f"Health check error: {e}")

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        """Main run loop with exponential backoff retry on disconnect."""
        while not self._stopped:
            health_task = None
            try:
                self.client = self._build_client()
                self._ready_event.clear()

                health_task = asyncio.create_task(self._health_check_loop())

                async with self.client:
                    await self.client.start(self.config.token, reconnect=True)
            except discord.LoginFailure:
                self.logger.error("Invalid bot token. Will not retry.")
                self._stopped = True
            except Exception as e:
                self.logger.error(f"Error: {e}")
            finally:
                if health_task is not None:
                    health_task.cancel()
                    try:
                        await health_task
                    except (asyncio.CancelledError, Exception):
                        pass

            if not self._stopped:
                self.logger.info(f"Retrying in {self._retry_delay}s...")
                await asyncio.sleep(self._retry_delay)
                self._retry_delay = min(self._retry_delay * 2, 60)

    async def stop(self) -> None:
        """Gracefully disconnect voice, close the client, and cancel the run loop."""
        self._stopped = True

        try:
            if self.client and not self.client.is_closed():
                await self.client.close()
        except Exception:
            pass

        if self._task is not None:
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    async def wait_until_ready(self) -> None:
        await self._ready_event.wait()


class BotManager:
    def __init__(self) -> None:
        self.instances: List[BotInstance] = []

    def add_bot(self, config: BotConfig) -> BotInstance:
        instance = BotInstance(config)
        self.instances.append(instance)
        return instance

    async def start_all(self) -> None:
        for instance in self.instances:
            await instance.start()

    async def wait_until_all_ready(self) -> None:
        for instance in self.instances:
            await instance.wait_until_ready()

    async def stop_all(self) -> None:
        await asyncio.gather(
            *[instance.stop() for instance in self.instances],
            return_exceptions=True,
        )

    async def run_forever(self) -> None:
        tasks = [instance._task for instance in self.instances if instance._task is not None]
        if not tasks:
            return
        await asyncio.gather(*tasks, return_exceptions=True)
