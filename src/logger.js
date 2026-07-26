/**
 * logger.js
 *
 * Minimal structured logger. Railway captures stdout/stderr line by line,
 * so every log call emits exactly one line: `[timestamp] [LEVEL] message`.
 * Errors get their stack trace on the following lines for readability.
 */

const LEVELS = Object.freeze({
    INFO: "INFO",
    WARN: "WARN",
    ERROR: "ERROR",
    SUCCESS: "SUCCESS",
    DEBUG: "DEBUG"
});

function timestamp() {
    return new Date().toISOString();
}

function format(level, message) {
    return `[${timestamp()}] [${level}] ${message}`;
}

function serializeError(error) {
    if (!error) {
        return "";
    }

    if (error instanceof Error) {
        return `\n${error.stack ?? `${error.name}: ${error.message}`}`;
    }

    try {
        return `\n${JSON.stringify(error)}`;
    } catch {
        return `\n${String(error)}`;
    }
}

const Logger = Object.freeze({
    info(message) {
        console.log(format(LEVELS.INFO, message));
    },

    warn(message) {
        console.warn(format(LEVELS.WARN, message));
    },

    error(message, error = null) {
        console.error(format(LEVELS.ERROR, message) + serializeError(error));
    },

    success(message) {
        console.log(format(LEVELS.SUCCESS, message));
    },

    debug(message) {
        console.debug(format(LEVELS.DEBUG, message));
    }
});

export default Logger;
