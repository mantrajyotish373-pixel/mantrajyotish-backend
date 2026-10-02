/**
 * Work that must not delay the response (availability flags, legacy mirrors, cache refresh) is
 * tracked here so tests and graceful shutdown can wait for it. Failures are logged, never thrown
 * into the session lifecycle.
 */
const pending = new Set();

const runInBackground = (promise, label = "background task") => {
    const p = Promise.resolve(promise)
        .catch((err) => console.warn(`Session ${label} warning:`, err && err.message))
        .finally(() => pending.delete(p));
    pending.add(p);
    return p;
};

const flushBackground = async () => {
    while (pending.size) await Promise.all([...pending]);
};

module.exports = { runInBackground, flushBackground };
