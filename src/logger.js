class Logger {
    static timestamp() {
        return new Date().toISOString();
    }

    static format(level, message) {
        return `[${this.timestamp()}] [${level}] ${message}`;
    }

    static info(message) {
        console.log(this.format("INFO", message));
    }

    static warn(message) {
        console.warn(this.format("WARN", message));
    }

    static error(message, error = null) {
        console.error(this.format("ERROR", message));

        if (error) {
            console.error(error);
        }
    }

    static debug(message) {
        console.log(this.format("DEBUG", message));
    }

    static success(message) {
        console.log(this.format("SUCCESS", message));
    }
}

export default Logger;
