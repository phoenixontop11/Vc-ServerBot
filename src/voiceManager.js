import {
    joinVoiceChannel,
    entersState,
    VoiceConnectionStatus,
    VoiceConnectionDisconnectReason
} from "@discordjs/voice";

import config from "./config.js";
import Logger from "./logger.js";

class VoiceManager {
    constructor(client) {
        this.client = client;

        this.connection = null;

        this.guild = null;

        this.channel = null;

        this.isConnecting = false;

        this.isReconnecting = false;

        this.reconnectAttempts = 0;

        this.reconnectTimer = null;

        this.destroyed = false;
    }

    async start() {
        Logger.info("Starting Voice Manager...");

        this.guild = await this.client.guilds.fetch(
            config.bot.guildId
        );

        this.channel = await this.client.channels.fetch(
            config.bot.voiceChannelId
        );

        if (!this.channel) {
            throw new Error("Voice channel not found.");
        }

        await this.connect();
    }

    async connect() {

    if (this.destroyed) {
        return;
    }

    if (this.isConnecting) {
        return;
    }

        this.isConnecting = true;

        Logger.info("Connecting to voice channel...");

        try {

            this.connection = joinVoiceChannel({

                guildId: this.guild.id,

                channelId: this.channel.id,

                adapterCreator: this.guild.voiceAdapterCreator,

                selfDeaf: true,

                selfMute: false

            });

            this.registerEvents();

            await entersState(

                this.connection,

                VoiceConnectionStatus.Ready,

                config.reconnect.timeout

            );

            this.isConnecting = false;

            this.reconnectAttempts = 0;

            Logger.success("Voice connection established.");

        } catch (error) {

    this.isConnecting = false;

    if (this.connection) {
        try {
            this.connection.destroy();
        } catch {}

        this.connection = null;
    }

    Logger.error("Voice connection failed.", error);

    this.scheduleReconnect();
}

    }

    registerEvents() {

        if (!this.connection) {
            return;
        }

        this.connection.removeAllListeners();

        this.connection.on(
            VoiceConnectionStatus.Ready,
            () => {

                Logger.success("Voice Ready.");

            }
        );

        this.connection.on(
            VoiceConnectionStatus.Connecting,
            () => {

                Logger.info("Voice Connecting...");

            }
        );

        this.connection.on(
            VoiceConnectionStatus.Signalling,
            () => {

                Logger.debug("Voice Signalling...");

            }
        );
              this.connection.on(
            VoiceConnectionStatus.Disconnected,
            async (_, newState) => {

                Logger.warn("Voice disconnected.");

                try {

                    if (
                        newState.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
                        newState.closeCode === 4014
                    ) {

                        Logger.warn("Voice server changed. Waiting...");

                        await entersState(
                            this.connection,
                            VoiceConnectionStatus.Connecting,
                            5000
                        );

                        Logger.success("Voice reconnected.");

                        return;
                    }

                    await entersState(
                        this.connection,
                        VoiceConnectionStatus.Signalling,
                        5000
                    );

                    Logger.success("Recovered voice connection.");

                } catch {

                    Logger.warn("Recovery failed.");

                    this.scheduleReconnect();

                }

            }
        );

        this.connection.on(
            VoiceConnectionStatus.Destroyed,
            () => {

                Logger.warn("Voice connection destroyed.");

                this.scheduleReconnect();

            }
        );

    }

    scheduleReconnect() {

    if (this.destroyed) {
        return;
    }

    if (this.isReconnecting) {
        return;
    }  

        this.isReconnecting = true;

        this.reconnectAttempts++;

        const delay = Math.min(

            config.reconnect.initialDelay *

            Math.pow(2, this.reconnectAttempts - 1),

            config.reconnect.maxDelay

        );

        Logger.warn(
            `Reconnect attempt ${this.reconnectAttempts} in ${delay / 1000}s`
        );

        clearTimeout(this.reconnectTimer);

        this.reconnectTimer = setTimeout(async () => {

            await this.reconnect();

        }, delay);

    }

    async reconnect() {

        this.isReconnecting = false;

        Logger.info("Starting reconnect...");

        try {

            if (this.connection) {

                this.connection.destroy();

                this.connection = null;

            }

        } catch {}

        try {
    await this.connect();
} catch (error) {
    Logger.error("Reconnect failed.", error);
    this.scheduleReconnect();
}

    }
      async healthCheck() {

        if (!this.guild || !this.channel) {
            return;
        }

        try {

            const botMember = await this.guild.members.fetch(
                this.client.user.id
            );

            if (!botMember.voice.channelId) {

                Logger.warn("Bot is not connected to any voice channel.");

                await this.reconnect();

                return;
            }

            if (botMember.voice.channelId !== this.channel.id) {

                Logger.warn("Bot moved to another voice channel.");

                await this.reconnect();

                return;
            }

            if (!this.connection) {

                Logger.warn("Voice connection object missing.");

                await this.reconnect();

                return;
            }

            Logger.debug("Voice health check passed.");

        } catch (error) {

            Logger.error("Health check failed.", error);

            await this.reconnect();

        }

    }

    async stop() {

        this.destroyed = true;

        clearTimeout(this.reconnectTimer);

        if (this.connection) {

            try {

                this.connection.destroy();

            } catch {}

            this.connection = null;

        }

        Logger.info("Voice Manager stopped.");

    }

}

export default VoiceManager;
