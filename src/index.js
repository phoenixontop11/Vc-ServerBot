import { Client, GatewayIntentBits } from "discord.js";

import config from "./config.js";
import Logger from "./logger.js";
import VoiceManager from "./voiceManager.js";
import Watchdog from "./watchdog.js";

const client = new Client({

    intents: [

        GatewayIntentBits.Guilds,

        GatewayIntentBits.GuildVoiceStates

    ]

});

const voiceManager = new VoiceManager(client);

const watchdog = new Watchdog(client, voiceManager);

client.once("ready", async () => {

    Logger.success(

        `Logged in as ${client.user.tag}`

    );

    try {

        await voiceManager.start();

        watchdog.start();

    } catch (error) {

        Logger.error(

            "Failed to initialize Voice Manager.",

            error

        );

    }

});

client.on("error", (error) => {

    Logger.error("Discord Client Error", error);

});

client.on("shardError", (error) => {

    Logger.error("Discord Gateway Error", error);

});

process.on("SIGINT", async () => {

    Logger.warn("SIGINT received.");

    watchdog.stop();

    await voiceManager.stop();

    process.exit(0);

});

process.on("SIGTERM", async () => {

    Logger.warn("SIGTERM received.");

    watchdog.stop();

    await voiceManager.stop();

    process.exit(0);

});

client.login(config.bot.token);
