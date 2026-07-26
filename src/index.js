/**
 * index.js
 *
 * Entry point. Wires together the Discord client, VoiceManager, and
 * Watchdog, and owns process-level concerns: login retries, global
 * error handling, and graceful shutdown on Railway restarts/deploys.
 */

import { Client, GatewayIntentBits } from "discord.js";

import config from "./config.js";
import Logger from "./logger.js";
import VoiceManager from "./voiceManager.js";
import Watchdog from "./watchdog.js";

// Only non-privileged intents are required:
//  - Guilds:            basic guild/channel caching.
//  - GuildVoiceStates:  required by @discordjs/voice to track voice
//                        state updates for the connection.
// Member state used by the watchdog's health check is fetched directly
// over REST (guild.members.fetch), so the privileged GuildMembers
// intent is not needed.
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
});

const voiceManager = new VoiceManager(client);
const watchdog = new Watchdog(voiceManager);

let shuttingDown = false;

// ---------------------------------------------------------------------
// Discord client events
// ---------------------------------------------------------------------

client.once("ready", async () => {
    Logger.success(`Logged in as ${client.user.tag}.`);

    try {
        await voiceManager.start();
        watchdog.start();
    } catch (error) {
        Logger.error(
            "Failed to initialize voice connection on startup. The watchdog and internal reconnect logic will keep retrying.",
            error
        );
    }
});

client.on("error", (error) => {
    Logger.error("Discord client error.", error);
});

client.on("shardError", (error) => {
    Logger.error("Discord gateway (shard) error.", error);
});

client.on("shardDisconnect", (event, shardId) => {
    Logger.warn(`Shard ${shardId} disconnected (code ${event?.code ?? "unknown"}).`);
});

client.on("shardReconnecting", (shardId) => {
    Logger.warn(`Shard ${shardId} reconnecting to the gateway...`);
});

client.on("shardResume", (shardId) => {
    Logger.success(`Shard ${shardId} resumed.`);
});

client.on("invalidated", () => {
    Logger.error(
        "Discord session invalidated. The process will exit so Railway can restart it cleanly."
    );
    process.exit(1);
});

// ---------------------------------------------------------------------
// Login with retry
// ---------------------------------------------------------------------

async function loginWithRetry() {
    let attempt = 0;

    while (!shuttingDown) {
        attempt += 1;

        try {
            await client.login(config.bot.token);
            return;
        } catch (error) {
            Logger.error(`Login attempt ${attempt} failed.`, error);

            const delay = Math.min(
                config.login.initialDelayMs * 2 ** (attempt - 1),
                config.login.maxDelayMs
            );

            Logger.warn(`Retrying login in ${Math.round(delay / 1000)}s.`);
            await sleep(delay);
        }
    }
}

function sleep(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
    });
}

// ---------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    Logger.warn(`${signal} received. Shutting down gracefully...`);

    const forceExitTimer = setTimeout(() => {
        Logger.error("Graceful shutdown timed out. Forcing exit.");
        process.exit(1);
    }, config.shutdown.gracePeriodMs);
    forceExitTimer.unref?.();

    try {
        watchdog.stop();
        await voiceManager.stop();
        client.destroy();
        Logger.info("Shutdown complete.");
        clearTimeout(forceExitTimer);
        process.exit(0);
    } catch (error) {
        Logger.error("Error during shutdown.", error);
        clearTimeout(forceExitTimer);
        process.exit(1);
    }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ---------------------------------------------------------------------
// Global safety nets
// ---------------------------------------------------------------------
//
// These do not replace proper error handling elsewhere - every async
// path in this project already catches its own errors - but they exist
// as a last line of defense so one unexpected rejection never silently
// kills a bot that is supposed to run for months unattended.

process.on("unhandledRejection", (reason) => {
    Logger.error("Unhandled promise rejection.", reason);
});

process.on("uncaughtException", (error) => {
    Logger.error(
        "Uncaught exception. Attempting to continue running.",
        error
    );
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

Logger.info("VC Server Bot starting...");
await loginWithRetry();
