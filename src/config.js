function requireEnv(name) {
    const value = process.env[name];

    if (!value || value.trim() === "") {
        throw new Error(`[CONFIG] Missing Railway Variable: ${name}`);
    }

    return value.trim();
}

const config = {
    bot: {
        token: requireEnv("DISCORD_TOKEN"),
        guildId: requireEnv("GUILD_ID"),
        voiceChannelId: requireEnv("VOICE_CHANNEL_ID")
    },

    reconnect: {
        enabled: true,

        initialDelay: 5000,      // 5 seconds
        maxDelay: 60000,          // 1 minute
        timeout: 15000,           // 15 seconds

        maxAttempts: Infinity
    },

    watchdog: {
        enabled: true,

        interval: 30000,          // Every 30 seconds

        reconnectIfMissing: true
    },

    logging: {
        timestamps: true,
        debug: true
    }
};

export default config;
