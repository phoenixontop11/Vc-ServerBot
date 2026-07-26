/**
 * config.js
 *
 * Centralized, validated configuration.
 * All values come exclusively from Railway environment variables.
 * No .env files, no defaults for required secrets.
 */

function requireEnv(name) {
    const value = process.env[name];

    if (value === undefined || value === null || value.trim() === "") {
        throw new Error(
            `Missing required Railway variable: ${name}. ` +
            `Set it in your Railway service Variables tab before starting the bot.`
        );
    }

    return value.trim();
}

function validateSnowflake(name, value) {
    if (!/^\d{5,25}$/.test(value)) {
        throw new Error(
            `Railway variable ${name} does not look like a valid Discord ID: "${value}"`
        );
    }

    return value;
}

const guildId = validateSnowflake("GUILD_ID", requireEnv("GUILD_ID"));
const voiceChannelId = validateSnowflake(
    "VOICE_CHANNEL_ID",
    requireEnv("VOICE_CHANNEL_ID")
);

const config = Object.freeze({
    bot: Object.freeze({
        token: requireEnv("DISCORD_TOKEN"),
        guildId,
        voiceChannelId
    }),

    voice: Object.freeze({
        selfDeaf: true,
        selfMute: false,

        // How long to wait for the connection to reach the Ready state
        // before treating the attempt as failed.
        readyTimeoutMs: 20_000,

        // How long to give a connection a chance to self-heal (e.g. voice
        // server migration, brief gateway resume) before we tear it down
        // and reconnect from scratch.
        recoveryWindowMs: 8_000
    }),

    reconnect: Object.freeze({
        // Base delay for exponential backoff.
        initialDelayMs: 5_000,

        // Upper bound for backoff so we never wait absurdly long.
        maxDelayMs: 60_000,

        // Random jitter added to every backoff so multiple restarts
        // (e.g. after a Railway-wide incident) do not all reconnect
        // in lockstep.
        jitterMs: 1_000
    }),

    watchdog: Object.freeze({
        intervalMs: 30_000
    }),

    login: Object.freeze({
        initialDelayMs: 5_000,
        maxDelayMs: 60_000
    }),

    shutdown: Object.freeze({
        // Hard cap on graceful shutdown before we force-exit.
        gracePeriodMs: 10_000
    })
});

export default config;
