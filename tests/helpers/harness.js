/**
 * Test harness: a throwaway standalone mongod (no replica set, so tests also prove the
 * engine needs no transactions), the real Socket.IO server from src/config/socket.js,
 * and small fixture helpers. Tests never touch the production database.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret";
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "test-refresh-secret";
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_test_dummy";
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "dummy_secret";
process.env.MONGO_URI = "mongodb://127.0.0.1:1/unused"; // never used; harness connects explicitly

const mongoose = require("mongoose");

const freePort = () =>
    new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const startMongo = async () => {
    const port = await freePort();
    const dbPath = fs.mkdtempSync(path.join(os.tmpdir(), "mj-test-mongo-"));
    const proc = spawn(
        "mongod",
        ["--dbpath", dbPath, "--port", String(port), "--bind_ip", "127.0.0.1", "--nounixsocket"],
        { stdio: "ignore" }
    );
    const uri = `mongodb://127.0.0.1:${port}/session_engine_test`;

    // wait until mongod accepts connections
    const deadline = Date.now() + 30000;
    for (;;) {
        try {
            await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 });
            break;
        } catch (err) {
            if (Date.now() > deadline) throw new Error("mongod did not start: " + err.message);
            await sleep(200);
        }
    }

    const stop = async () => {
        await mongoose.disconnect().catch(() => null);
        proc.kill("SIGTERM");
        await new Promise((r) => proc.once("exit", r));
        fs.rmSync(dbPath, { recursive: true, force: true });
    };
    return { uri, stop };
};

/** Drop all data but keep indexes (so unique/partial indexes stay enforced). */
const resetData = async () => {
    const collections = await mongoose.connection.db.collections();
    for (const c of collections) await c.deleteMany({});
};

/** Make sure every model's indexes exist before a test relies on them. */
const syncAllIndexes = async () => {
    for (const name of mongoose.modelNames()) {
        await mongoose.model(name).syncIndexes();
    }
};

let phoneCounter = 9000000000;
const createUser = async (overrides = {}) => {
    const User = require("../../src/models/user.model");
    phoneCounter += 1;
    return User.create({
        phone: `+91${phoneCounter}`,
        name: "Test User",
        firstname: "Test",
        lastname: "User",
        walletBalance: 500,
        ...overrides
    });
};

let astroCounter = 0;
const createAstrologer = async (overrides = {}) => {
    const Astrologer = require("../../src/models/astro.model");
    astroCounter += 1;
    return Astrologer.create({
        name: `Astro ${astroCounter}`,
        email: `astro${astroCounter}@test.dev`,
        phone: `+9188${String(astroCounter).padStart(8, "0")}`,
        status: "approved",
        isOnline: true,
        isAvailable: true,
        manualOffline: false, // schema default is true; a genuinely online astrologer has it false
        consultationFee: 12,
        ...overrides
    });
};

let adminCounter = 0;
const createAdmin = async (overrides = {}) => {
    const Admin = require("../../src/models/admin.model");
    adminCounter += 1;
    return Admin.create({ name: "Admin", email: `admin${adminCounter}@test.dev`, password: "x", role: "superadmin", walletBalance: 0, ...overrides });
};

/** Engine actors, shaped like the decoded JWT the REST/socket layers pass in. */
const asUser = (user) => ({ user: { userId: String(user._id), role: "user" } });
const asAstrologer = (astro) => ({ user: { userId: String(astro._id), role: "astrologer" } });
const SYSTEM = { system: true };

const tokenFor = (doc, role) => {
    const { generateToken } = require("../../src/utils/jwt");
    return generateToken({ userId: String(doc._id), role });
};

/** Real Socket.IO server using the application's initSocket (no Redis => no adapter). */
const startRealtime = async () => {
    const { initSocket } = require("../../src/config/socket");
    const server = http.createServer();
    const io = initSocket(server);
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}`;
    const clients = [];

    const connect = (token, extraAuth = {}) =>
        new Promise((resolve, reject) => {
            const { io: ioc } = require("socket.io-client");
            const sock = ioc(url, {
                transports: ["websocket"],
                auth: { token, ...extraAuth },
                reconnection: false,
                forceNew: true
            });
            const inbox = [];
            sock.onAny((event, ...args) => inbox.push({ event, args }));
            sock.inbox = inbox;
            sock.waitFor = (event, ms = 3000, predicate = () => true) =>
                new Promise((res, rej) => {
                    const existing = inbox.find((m) => m.event === event && predicate(m.args[0]));
                    if (existing) return res(existing.args[0]);
                    const t = setTimeout(() => {
                        sock.off(event, handler);
                        rej(new Error(`timeout waiting for '${event}' (got: ${inbox.map((m) => m.event).join(", ") || "nothing"})`));
                    }, ms);
                    const handler = (payload) => {
                        if (!predicate(payload)) return;
                        clearTimeout(t);
                        sock.off(event, handler);
                        res(payload);
                    };
                    sock.on(event, handler);
                });
            sock.has = (event) => inbox.some((m) => m.event === event);
            sock.count = (event) => inbox.filter((m) => m.event === event).length;
            sock.emitAck = (event, payload) =>
                new Promise((res, rej) => {
                    const t = setTimeout(() => rej(new Error(`no acknowledgement for '${event}'`)), 4000);
                    sock.emit(event, payload, (reply) => { clearTimeout(t); res(reply); });
                });
            sock.once("connect", () => resolve(sock));
            sock.once("connect_error", reject);
            clients.push(sock);
        });

    const stop = async () => {
        clients.forEach((c) => c.close());
        io.close();
        await new Promise((r) => server.close(r));
    };
    return { io, url, connect, stop };
};

module.exports = {
    startMongo,
    resetData,
    syncAllIndexes,
    createUser,
    createAstrologer,
    createAdmin,
    asUser,
    asAstrologer,
    SYSTEM,
    tokenFor,
    startRealtime,
    sleep
};
