/**
 * voiceManager.js
 *
 * Owns the single voice connection this bot maintains. Implements an
 * explicit state machine so that "what is the bot doing right now" is
 * always a single, well-defined value instead of a pile of booleans.
 *
 * States:
 *   IDLE          - not started yet
 *   CONNECTING    - actively trying to join / rejoin the voice channel
 *   CONNECTED     - joined and the connection is Ready
 *   RECONNECTING  - waiting out a backoff delay before the next attempt
 *   STOPPING      - shutdown requested, cleaning up
 *   STOPPED       - fully torn down, will not reconnect again
 *
 * Race-condition safety:
 *   Every connection attempt is tagged with an incrementing "epoch".
 *   Async work (entersState, timers, event handlers) captures the epoch
 *   that was current when it started. Before that work is allowed to
 *   mutate state, it checks its captured epoch against the current one.
 *   Any attempt started after it - or a stop() call - bumps the epoch,
 *   which silently retires all in-flight work from earlier attempts.
 *   This is what prevents duplicate reconnects, ghost connections, and
 *   half-open sessions from stacking on top of each other.
 */

import {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    VoiceConnectionDisconnectReason
} from "@discordjs/voice";

import config from "./config.js";
import Logger from "./logger.js";

export const VoiceManagerState = Object.freeze({
    IDLE: "IDLE",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    RECONNECTING: "RECONNECTING",
    STOPPING: "STOPPING",
    STOPPED: "STOPPED"
});

class VoiceManager {
    constructor(client) {
        this.client = client;

        this.guild = null;
        this.channel = null;
        this.connection = null;

        this.state = VoiceManagerState.IDLE;

        // Bumped on every connect attempt and on stop(). Any async
        // callback that captured an older epoch treats itself as stale
        // and does nothing.
        this.epoch = 0;

        this.reconnectAttempts = 0;
        this.reconnectTimer = null;

        // Prevents the watchdog from fighting with a resync that is
        // already in flight.
        this.lastForcedResyncAt = 0;
    }

    // ---------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------

    async start() {
        Logger.info("Starting Voice Manager...");

        this.guild = await this.client.guilds.fetch(config.bot.guildId);

        const channel = await this.client.channels.fetch(
            config.bot.voiceChannelId
        );

        if (!channel) {
            throw new Error(
                `Voice channel ${config.bot.voiceChannelId} was not found.`
            );
        }

        if (!channel.isVoiceBased?.()) {
            throw new Error(
                `Channel ${config.bot.voiceChannelId} is not a voice channel.`
            );
        }

        this.channel = channel;

        await this.connect();
    }

    async stop() {
        Logger.info("Stopping Voice Manager...");

        this.state = VoiceManagerState.STOPPING;

        // Retiring every in-flight attempt/event handler.
        this.epoch += 1;

        this._clearReconnectTimer();
        this._destroyConnection();

        this.state = VoiceManagerState.STOPPED;

        Logger.info("Voice Manager stopped.");
    }

    // ---------------------------------------------------------------
    // Connecting
    // ---------------------------------------------------------------

    async connect() {
        if (this._isTerminal()) {
            return;
        }

        // Already actively trying - do not start a second, overlapping
        // attempt.
        if (this.state === VoiceManagerState.CONNECTING) {
            return;
        }

        this._clearReconnectTimer();
        this._destroyConnection();

        const myEpoch = ++this.epoch;
        this.state = VoiceManagerState.CONNECTING;

        Logger.info("Connecting to voice channel...");

        try {
            const connection = joinVoiceChannel({
                guildId: this.guild.id,
                channelId: this.channel.id,
                adapterCreator: this.guild.voiceAdapterCreator,
                selfDeaf: config.voice.selfDeaf,
                selfMute: config.voice.selfMute
            });

            this.connection = connection;
            this._registerConnectionEvents(connection, myEpoch);

            await entersState(
                connection,
                VoiceConnectionStatus.Ready,
                config.voice.readyTimeoutMs
            );

            if (!this._isCurrentEpoch(myEpoch)) {
                // A newer attempt (or a stop()) superseded this one while
                // we were awaiting readiness. Leave the newer attempt's
                // connection alone and do not touch shared state.
                return;
            }

            this.state = VoiceManagerState.CONNECTED;
            this.reconnectAttempts = 0;

            Logger.success("Voice connection established and ready.");
        } catch (error) {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            Logger.error("Voice connection attempt failed.", error);
            this._destroyConnection();
            this._scheduleReconnect();
        }
    }

    // ---------------------------------------------------------------
    // Event handling for a single connection instance
    // ---------------------------------------------------------------

    _registerConnectionEvents(connection, myEpoch) {
        connection.on(VoiceConnectionStatus.Ready, () => {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            this.state = VoiceManagerState.CONNECTED;
            this.reconnectAttempts = 0;
            Logger.success("Voice connection ready.");
        });

        connection.on(VoiceConnectionStatus.Connecting, () => {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            Logger.debug("Voice connection: connecting...");
        });

        connection.on(VoiceConnectionStatus.Signalling, () => {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            Logger.debug("Voice connection: signalling...");
        });

        connection.on(
            VoiceConnectionStatus.Disconnected,
            async (_oldState, newState) => {
                if (!this._isCurrentEpoch(myEpoch)) {
                    return;
                }

                Logger.warn("Voice connection disconnected.");

                try {
                    const isWebsocketClose =
                        newState.reason ===
                        VoiceConnectionDisconnectReason.WebSocketClose;

                    // Close code 4014 means the bot was removed from the
                    // channel, or the channel was deleted, or the guild
                    // lost the ability to connect (e.g. permission
                    // change). @discordjs/voice will not recover from
                    // this on its own, so we wait briefly in case it is a
                    // voice server migration, then fall through to a
                    // clean reconnect.
                    if (isWebsocketClose && newState.closeCode === 4014) {
                        await entersState(
                            connection,
                            VoiceConnectionStatus.Connecting,
                            config.voice.recoveryWindowMs
                        );

                        if (this._isCurrentEpoch(myEpoch)) {
                            Logger.success(
                                "Voice connection recovered after migration."
                            );
                        }

                        return;
                    }

                    // Transient blip (gateway resume, brief network
                    // hiccup): give @discordjs/voice a short window to
                    // self-heal before we intervene.
                    await entersState(
                        connection,
                        VoiceConnectionStatus.Signalling,
                        config.voice.recoveryWindowMs
                    );

                    if (this._isCurrentEpoch(myEpoch)) {
                        Logger.success("Voice connection self-recovered.");
                    }
                } catch {
                    if (!this._isCurrentEpoch(myEpoch)) {
                        return;
                    }

                    Logger.warn(
                        "Voice connection did not self-recover in time. Reconnecting."
                    );

                    this._destroyConnection();
                    this._scheduleReconnect();
                }
            }
        );

        connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            Logger.warn("Voice connection destroyed.");

            if (this.connection === connection) {
                this.connection = null;
            }

            if (!this._isTerminal()) {
                this._scheduleReconnect();
            }
        });

        connection.on("error", (error) => {
            if (!this._isCurrentEpoch(myEpoch)) {
                return;
            }

            Logger.error("Voice connection emitted an error.", error);
        });
    }

    // ---------------------------------------------------------------
    // Reconnect scheduling
    // ---------------------------------------------------------------

    _scheduleReconnect() {
        if (this._isTerminal()) {
            return;
        }

        // A reconnect is already pending - do not stack another one.
        if (this.reconnectTimer) {
            return;
        }

        this.state = VoiceManagerState.RECONNECTING;
        this.reconnectAttempts += 1;

        const delay = this._computeBackoffDelay(this.reconnectAttempts);

        Logger.warn(
            `Scheduling reconnect attempt ${this.reconnectAttempts} in ${Math.round(delay / 1000)}s.`
        );

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect().catch((error) => {
                Logger.error("Unhandled error during reconnect.", error);
                this._scheduleReconnect();
            });
        }, delay);

        // Never let a scheduled reconnect keep the process alive on its
        // own if everything else has shut down.
        this.reconnectTimer.unref?.();
    }

    _computeBackoffDelay(attempt) {
        const exponential =
            config.reconnect.initialDelayMs * 2 ** (attempt - 1);

        const capped = Math.min(exponential, config.reconnect.maxDelayMs);

        const jitter = Math.floor(Math.random() * config.reconnect.jitterMs);

        return capped + jitter;
    }

    // ---------------------------------------------------------------
    // Watchdog support
    // ---------------------------------------------------------------

    /**
     * Verifies actual Discord-side state (not just our local objects)
     * and forces a resync if reality has drifted from what we expect.
     */
    async healthCheck() {
        if (this._isTerminal()) {
            return;
        }

        if (!this.guild || !this.channel) {
            Logger.warn("Health check skipped: guild/channel not ready yet.");
            return;
        }

        if (!this.client.isReady()) {
            Logger.warn("Health check skipped: Discord client not ready.");
            return;
        }

        let botMember;

        try {
            botMember = await this.guild.members.fetch({
                user: this.client.user.id,
                force: true
            });
        } catch (error) {
            Logger.error(
                "Health check failed: could not fetch bot member.",
                error
            );
            return;
        }

        const actualChannelId = botMember.voice.channelId ?? null;

        if (actualChannelId !== this.channel.id) {
            Logger.warn(
                `Health check: bot is not in the target voice channel (found: ${actualChannelId ?? "none"}).`
            );
            this._forceResync();
            return;
        }

        if (
            !this.connection ||
            this.connection.state.status !== VoiceConnectionStatus.Ready
        ) {
            Logger.warn(
                "Health check: Discord reports the bot in-channel, but the local voice connection is missing or not ready."
            );
            this._forceResync();
            return;
        }

        Logger.debug("Health check passed.");
    }

    _forceResync() {
        if (this._isTerminal()) {
            return;
        }

        // Do not force more than once per watchdog interval; an attempt
        // may already be in flight from the previous tick.
        const now = Date.now();

        if (now - this.lastForcedResyncAt < config.watchdog.intervalMs) {
            Logger.debug("Skipping forced resync: one is already recent.");
            return;
        }

        if (this.state === VoiceManagerState.CONNECTING) {
            Logger.debug("Skipping forced resync: a connect is in progress.");
            return;
        }

        this.lastForcedResyncAt = now;
        this._clearReconnectTimer();

        Logger.warn("Forcing voice resync.");

        this.connect().catch((error) => {
            Logger.error("Unhandled error during forced resync.", error);
        });
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    _destroyConnection() {
        if (!this.connection) {
            return;
        }

        try {
            this.connection.removeAllListeners();

            if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                this.connection.destroy();
            }
        } catch (error) {
            Logger.debug(
                `Ignoring error while destroying stale connection: ${error?.message ?? error}`
            );
        } finally {
            this.connection = null;
        }
    }

    _clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    _isCurrentEpoch(epoch) {
        return epoch === this.epoch && !this._isTerminal();
    }

    _isTerminal() {
        return (
            this.state === VoiceManagerState.STOPPING ||
            this.state === VoiceManagerState.STOPPED
        );
    }
}

export default VoiceManager;
