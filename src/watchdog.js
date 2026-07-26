/**
 * watchdog.js
 *
 * Periodically asks the VoiceManager to verify itself against real
 * Discord state (not just local in-memory flags) and correct any drift.
 */

import config from "./config.js";
import Logger from "./logger.js";

class Watchdog {
    constructor(voiceManager) {
        this.voiceManager = voiceManager;
        this.timer = null;
        this.running = false;
    }

    start() {
        if (this.timer) {
            return;
        }

        Logger.info("Starting watchdog...");

        this.timer = setInterval(() => {
            this._tick();
        }, config.watchdog.intervalMs);

        // Do not let the watchdog interval keep the process alive by
        // itself once everything else has shut down.
        this.timer.unref?.();

        Logger.success(
            `Watchdog running every ${config.watchdog.intervalMs / 1000}s.`
        );
    }

    stop() {
        if (!this.timer) {
            return;
        }

        clearInterval(this.timer);
        this.timer = null;

        Logger.info("Watchdog stopped.");
    }

    async _tick() {
        // Skip overlapping ticks if a previous health check is somehow
        // still running (e.g. a slow Discord API response).
        if (this.running) {
            Logger.debug("Watchdog tick skipped: previous check still running.");
            return;
        }

        this.running = true;

        try {
            await this.voiceManager.healthCheck();
        } catch (error) {
            Logger.error("Watchdog tick threw an unexpected error.", error);
        } finally {
            this.running = false;
        }
    }
}

export default Watchdog;
