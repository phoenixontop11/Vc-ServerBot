import config from "./config.js";
import Logger from "./logger.js";

class Watchdog {
    constructor(client, voiceManager) {
        this.client = client;
        this.voiceManager = voiceManager;
        this.interval = null;
    }

    start() {
        if (this.interval) {
            return;
        }

        Logger.info("Starting Watchdog...");

        this.interval = setInterval(async () => {

            try {

                await this.voiceManager.healthCheck();

            } catch (error) {

                Logger.error("Watchdog detected an error.", error);

            }

        }, config.watchdog.interval);

        Logger.success(
            `Watchdog running every ${config.watchdog.interval / 1000} seconds.`
        );
    }

    stop() {

        if (!this.interval) {
            return;
        }

        clearInterval(this.interval);

        this.interval = null;

        Logger.info("Watchdog stopped.");

    }
}

export default Watchdog;
