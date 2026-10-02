/**
 * Error with a stable machine-readable code so REST handlers and socket acknowledgements
 * can report failures consistently.
 */
class SessionError extends Error {
    constructor(code, message, status = 400, details = {}) {
        super(message);
        this.name = "SessionError";
        this.code = code;
        this.status = status;
        this.details = details;
    }
}

module.exports = { SessionError };
