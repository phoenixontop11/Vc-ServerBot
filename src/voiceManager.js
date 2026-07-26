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
 *   Async work (entersState, timers, event handlers) captures the
 *   epoch that was current when it started. Before that work is
 *   allowed to mutate state, it checks its captured epoch against the
 *   current one. Any attempt started after it - or a stop() call -
 *   bumps the epoch, retiring all in-flight work from earlier
 *   attempts. This prevents duplicate reconnects, ghost connections,
 *   and half-open sessions from stacking on top of each other.
 *
 * Disconnected-event handling:
 *   On Disconnected we never wait to *enter* an intermediate status
 *   (e.g. Signalling) - that status can already have been passed
 *   through by the time our handler runs, causing the wait to never
 *   resolve and a healthy, already-Ready connection to be destroyed.
 *   Instead we check for Ready immediately, wait for Ready itself if
 *   not already there, and re-check Ready once more before ever
 *   destroying anything.
 *
 * Watchdog:
 *   Uses guild.voiceStates.cache (gateway-fed, real-time) instead of a
 *   REST member fetch. A resync is only forced when BOTH the cached
 *   voice state and the local VoiceConnection status agree the
 *   connection is broken, and never while CONNECTING/RECONNECTING.
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

// How long we extend the wait each time entersState(Ready) times out
// during the *initial* handshake but the connection is still visibly
// negotiating (Connecting/Signalling).
const SOFT_TIMEOUT_EXTENSION_MS = 25_000;

// Hard ceiling on total time spent waiting for the *initial* handshake
// across all soft-timeout extensions.
const MAX_CONNECT_WAIT_MS = 90_000;

const NEGOTIATING_STATUSES = new Set([
    VoiceConnectionStatus.Connecting,
    VoiceConnectionStatus.Signalling
]);

// Distinguishes why a reconnect/resync was triggered, for diagnostics.
const ReconnectTrigger = Object.freeze({
    CONNECT_FAILURE: "connect() failure",
    DISCONNECTED_EVENT: "Disconnected event",
    DESTROYED_EVENT: "Destroyed event",
    WATCHDOG: "watchdog",
    MANUAL_RESYNC: "manual resync"
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

        // Set just before we intentionally call connection.destroy()
        // ourselves. The resulting synchronous Destroyed event checks
        // this flag so an intentional teardown can never recursively
        // trigger a second, redundant reconnect - the caller of
        // _destroyConnection() is always the one responsible for
        // calling _scheduleReconnect() afterwards, exactly once.
        this._expectingDestroyedEvent = false;
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

            await this._waitForReady(connection, myEpoch);

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

            this._logReconnectTrigger(ReconnectTrigger.CONNECT_FAILURE, {
                connectionStatus: this.connection?.state?.status
            });

            Logger.error("Voice connection attempt failed.", error);
            this._destroyConnection();
            this._scheduleReconnect();
        }
    }

    /**
     * Waits for the connection to reach Ready, tolerating soft timeouts
     * *during the initial handshake only*.
     */
    async _waitForReady(connection, myEpoch) {
        const startedAt = Date.now();
        let timeoutMs = config.voice.readyTimeoutMs;

        for (;;) {
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
                return;
            } catch (error) {
                if (!this._isCurrentEpoch(myEpoch)) {
                    throw error;
                }

                const status = connection.state.status;
                const elapsed = Date.now() - startedAt;
                const stillNegotiating = NEGOTIATING_STATUSES.has(status);
                const budgetRemaining = elapsed < MAX_CONNECT_WAIT_MS;

                if (stillNegotiating && budgetRemaining) {
                    Logger.warn(
                        `Ready timeout hit, but connection is still "${status}" after ${Math.round(elapsed / 1000)}s. Extending wait instead of tearing it down.`
                    );

                    timeoutMs = Math.min(
                        SOFT_TIMEOUT_EXTENSION_MS,
                        MAX_CONNECT_WAIT_MS - elapsed
                    );

                    continue;
                }

                throw error;
            }
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

                const reason = newState.reason;
                const closeCode = newState.closeCode;

                Logger.warn(
                    `Voice connection disconnected. reason=${reason ?? "unknown"}, closeCode=${closeCode ?? "n/a"}, currentStatus=${connection.state.status}`
                );

                // Fast-path: did we already self-heal? Never wait to
                // *enter* an intermediate status - it may already have
                // been passed through. Check Ready directly, first.
                if (connection.state.status === VoiceConnectionStatus.Ready) {
                    Logger.success(
                        "Voice connection had already self-recovered to Ready before we intervened - no action needed."
                    );
                    return;
                }

                try {
                    const isWebsocketClose =
                        reason === VoiceConnectionDisconnectReason.WebSocketClose;

                    if (isWebsocketClose && closeCode === 4014) {
                        Logger.warn(
                            "Close code 4014 detected - waiting to confirm whether this is a voice server migration or a real removal."
                        );
                    }

                    // Wait for the actual target we care about - Ready -
                    // using the existing recoveryWindowMs. entersState()
                    // resolves immediately if already Ready.
                    await entersState(
                        connection,
                        VoiceConnectionStatus.Ready,
                        config.voice.recoveryWindowMs
                    );

                    if (this._isCurrentEpoch(myEpoch)) {
                        Logger.success("Voice connection self-recovered to Ready.");
                    }
                } catch {
                    if (!this._isCurrentEpoch(myEpoch)) {
                        return;
                    }

                    // Final Ready check before ever destroying anything.
                    if (connection.state.status === VoiceConnectionStatus.Ready) {
                        Logger.success(
                            "Voice connection reached Ready just as the recovery wait ended - no action needed."
                        );
                        return;
                    }

                    this._logReconnectTrigger(ReconnectTrigger.DISCONNECTED_EVENT, {
                        connectionStatus: connection.state.status,
                        reason,
                        closeCode
                    });

                    Logger.warn(
                        "Voice connection did not recover to Ready in time. Reconnecting."
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

            if (this.connection === connection) {
                this.connection = null;
            }

            const wasExpected = this._expectingDestroyedEvent;
            this._expectingDestroyedEvent = false;

            if (wasExpected) {
                // The code path that called _destroyConnection() already
                // owns calling _scheduleReconnect() itself. Destroying a
                // connection must never recursively trigger a second,
                // independent reconnect here.
                Logger.debug(
                    "Voice connection Destroyed event fired as an expected result of an intentional teardown - already handled by the caller."
                );
                return;
            }

            this._logReconnectTrigger(ReconnectTrigger.DESTROYED_EVENT, {
                connectionStatus: VoiceConnectionStatus.Destroyed
            });

            Logger.warn("Voice connection destroyed unexpectedly.");

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
     *
     * Uses the gateway-cached voice state (guild.voiceStates.cache,
     * populated in real time by VOICE_STATE_UPDATE events received via
     * the GuildVoiceStates intent) instead of a REST member fetch.
     *
     * Never interrupts CONNECTING or RECONNECTING.
     *
     * Only forces a resync when BOTH the cached voice state AND the
     * connection object itself agree something is wrong - a single
     * disagreeing signal is never acted on, so a momentarily-stale read
     * of either source can never tear down a healthy connection.
     */
    async healthCheck() {
        if (this._isTerminal()) {
            return;
        }

        if (
            this.state === VoiceManagerState.CONNECTING ||
            this.state === VoiceManagerState.RECONNECTING
        ) {
            Logger.debug(
                `Health check skipped: connection is currently ${this.state}.`
            );
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

        const cachedVoiceState = this.guild.voiceStates.cache.get(
            this.client.user.id
        );
        const actualChannelId = cachedVoiceState?.channelId ?? null;
        const channelMismatch = actualChannelId !== this.channel.id;

        const connectionUnhealthy =
            !this.connection ||
            this.connection.state.status !== VoiceConnectionStatus.Ready;

        if (!channelMismatch && !connectionUnhealthy) {
            Logger.debug("Health check passed: connection is healthy.");
            return;
        }

        if (channelMismatch && connectionUnhealthy) {
            Logger.warn(
                `Health check: bot is not in the target voice channel (found: ${actualChannelId ?? "none"}) AND the local voice connection is missing or not ready. Repairing.`
            );
            this._forceResync(ReconnectTrigger.WATCHDOG);
            return;
        }

        // Only one signal disagrees - log it for visibility, but do not
        // act. A healthy Ready connection is never destroyed on a
        // single, possibly-stale signal.
        if (channelMismatch) {
            Logger.debug(
                `Health check: cached voice state reports channel ${actualChannelId ?? "none"}, but the connection object still looks healthy (status=${this.connection.state.status}). Not acting on a single signal - will re-check next tick.`
            );
        } else {
            Logger.debug(
                `Health check: connection object is not Ready (status=${this.connection?.state?.status ?? "none"}), but cached voice state still shows the bot in the target channel. Not acting on a single signal - will re-check next tick.`
            );
        }
    }

    /**
     * Public entry point for an operator-triggered resync (e.g. from an
     * admin command), distinct from the watchdog's automatic one purely
     * for diagnostic labeling.
     */
    requestManualResync() {
        this._forceResync(ReconnectTrigger.MANUAL_RESYNC);
    }

    _forceResync(trigger) {
        if (this._isTerminal()) {
            return;
        }

        // Never preempt an in-progress attempt.
        if (
            this.state === VoiceManagerState.CONNECTING ||
            this.state === VoiceManagerState.RECONNECTING
        ) {
            Logger.debug(
                `Skipping forced resync: connection is currently ${this.state}.`
            );
            return;
        }

        // Do not force more than once per watchdog interval; an attempt
        // may already be in flight from the previous tick.
        const now = Date.now();

        if (now - this.lastForcedResyncAt < config.watchdog.intervalMs) {
            Logger.debug("Skipping forced resync: one is already recent.");
            return;
        }

        this.lastForcedResyncAt = now;
        this._clearReconnectTimer();

        this._logReconnectTrigger(trigger, {
            connectionStatus: this.connection?.state?.status
        });

        Logger.warn("Forcing voice resync.");

        this.connect().catch((error) => {
            Logger.error("Unhandled error during forced resync.", error);
        });
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    /**
     * Rich diagnostic line emitted immediately before any action that
     * destroys and/or reconnects the voice connection: trigger source,
     * current VoiceConnectionStatus, current state machine state,
     * disconnect reason, close code, and the upcoming reconnect attempt
     * number.
     */
    _logReconnectTrigger(trigger, { connectionStatus, reason, closeCode } = {}) {
        const parts = [
            `trigger="${trigger}"`,
            `machineState=${this.state}`,
            `connectionStatus=${connectionStatus ?? "none"}`,
            `nextReconnectAttempt=${this.reconnectAttempts + 1}`
        ];

        if (reason !== undefined) {
            parts.push(`disconnectReason=${reason}`);
        }

        if (closeCode !== undefined) {
            parts.push(`closeCode=${closeCode}`);
        }

        Logger.warn(`[RECONNECT TRIGGERED] ${parts.join(", ")}`);
    }

    _destroyConnection() {
        if (!this.connection) {
            return;
        }

        try {
            this._expectingDestroyedEvent = true;

            this.connection.removeAllListeners(VoiceConnectionStatus.Ready);
            this.connection.removeAllListeners(VoiceConnectionStatus.Connecting);
            this.connection.removeAllListeners(VoiceConnectionStatus.Signalling);
            this.connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
            this.connection.removeAllListeners("error");
            // Deliberately NOT removing Destroyed listeners here - our
            // own Destroyed handler above must still observe the
            // teardown it is about to cause, so it can correctly
            // recognize it as expected via _expectingDestroyedEvent and
            // avoid recursively scheduling a second reconnect.

            if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                this.connection.destroy();
            } else {
                this.connection.removeAllListeners(VoiceConnectionStatus.Destroyed);
                this._expectingDestroyedEvent = false;
            }
        } catch (error) {
            this._expectingDestroyedEvent = false;
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
