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
 *
 * Soft-timeout handling for the initial handshake:
 *   @discordjs/voice's entersState() throws an AbortError the instant
 *   its timeout elapses, even if the connection is still legitimately
 *   negotiating (Connecting/Signalling) rather than actually stuck.
 *   Destroying the connection at that exact moment is what causes the
 *   "briefly joins then disconnects" symptom - the handshake was about
 *   to succeed and got torn down out from under itself. See
 *   _waitForReady() below: on timeout we inspect the connection's real
 *   status and, if it is still making progress, extend the wait
 *   instead of destroying it, up to an overall cap.
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

// How long we extend the wait each time entersState(Ready) times out but
// the connection is still visibly negotiating (Connecting/Signalling).
const SOFT_TIMEOUT_EXTENSION_MS = 25_000;

// Hard ceiling on total time spent waiting for the initial handshake
// across all soft-timeout extensions. Past this, a connection that is
// still "negotiating" is treated as genuinely stalled.
const MAX_CONNECT_WAIT_MS = 90_000;

const NEGOTIATING_STATUSES = new Set([
    VoiceConnectionStatus.Connecting,
    VoiceConnectionStatus.Signalling
]);

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

            Logger.error("Voice connection attempt failed.", error);
            this._destroyConnection();
            this._scheduleReconnect();
        }
    }

    /**
     * Waits for the connection to reach Ready, tolerating soft timeouts.
     *
     * entersState() throws as soon as its own timeout elapses, which
     * does not necessarily mean the handshake failed - it may simply
     * still be in progress. On timeout we check the connection's actual
     * status: if it is still Connecting or Signalling (i.e. genuinely
     * making progress rather than stuck), we extend the wait instead of
     * giving up immediately. We only surface a real failure once the
     * connection is no longer negotiating, or the overall time budget
     * (MAX_CONNECT_WAIT_MS) is exhausted.
     */
    async _waitForReady(connection, myEpoch) {
        const startedAt = Date.now();
        let timeoutMs = config.voice.readyTimeoutMs;

        for (;;) {
            try {
                await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
                return;
            } catch (error) {
                // A newer attempt or a stop() superseded us mid-wait -
                // bail out quietly, the caller will no-op on stale epoch.
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

                // Either genuinely stalled (not negotiating anymore) or
                // we've exhausted the total time budget. Let the caller
                // handle the real failure.
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

                Logger.warn("Voice connection disconnected.");

                try {
                    const isWebsocketClose =
                        newState.reason ===
                        VoiceConnectionDisconnectReason.WebSocketClose;

                    // Close code 4014 means the bot was removed from the
                    // channel, the channel was deleted, or the guild lost
                    // the ability to connect (e.g. permission change) -
                    // OR it can be a voice server migration in disguise.
                    // @discordjs/voice will not always recover from this
                    // on its own, so we wait briefly in case the session
                    // resumes, then fall through to a clean reconnect.
                    if (isWebsocketClose && newState.closeCode === 4014) {
                        Logger.warn(
                            "Close code 4014 detected - waiting to see if this is a voice server migration rather than a real removal."
                        );

                        await entersState(
                            connection,
                            VoiceConnectionStatus.Connecting,
                            config.voice.recoveryWindowMs
                        );

                        if (this._isCurrentEpoch(myEpoch)) {
                            Logger.success(
                                "Voice connection recovered after migration (4014)."
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
     *
     * Never interrupts CONNECTING or RECONNECTING: a connection that is
     * still negotiating its initial handshake, or waiting out a backoff
     * delay, must be left alone. Interrupting it here would race with
     * connect() and reintroduce the exact "briefly joins then
     * disconnects" bug this file exists to prevent.
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
                "Health check: Discord reports the bot in-channel (ghost connection) - local voice connection is missing or not ready. Repairing."
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

        // Redundant with the guard in healthCheck(), kept here too since
        // _forceResync() could in principle be called from elsewhere in
        // the future - it must never preempt an in-progress attempt.
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
