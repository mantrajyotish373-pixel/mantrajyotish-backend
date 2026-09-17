const dns = require("dns");
try {
    dns.setDefaultResultOrder("ipv4first");
} catch (e) {}

const fs = require("fs");
const path = require("path");

const nodeEnv = process.env.NODE_ENV || "development";
let envLoaded = false;

if (fs.existsSync(path.resolve(process.cwd(), ".env"))) {
    require("dotenv").config({ path: ".env" });
    console.log("◇ Loaded environment variables from .env");
    envLoaded = true;
} else if (nodeEnv === "production" && fs.existsSync(path.resolve(process.cwd(), ".env.production"))) {
    require("dotenv").config({ path: ".env.production" });
    console.log("◇ Loaded environment variables from .env.production");
    envLoaded = true;
} else if (fs.existsSync(path.resolve(process.cwd(), ".env.development"))) {
    require("dotenv").config({ path: ".env.development" });
    console.log("◇ Loaded environment variables from .env.development");
    envLoaded = true;
}

if (!envLoaded) {
    require("dotenv").config();
    console.log("◇ Loaded environment variables from default .env");
}
require("./src/config/config");

const http = require("http");
const app = require("./src/app");
const connectDB = require("./src/config/db");
const { initSocket } = require("./src/config/socket");
const { initRedis } = require("./src/config/redis");

const PORT = process.env.PORT || 3000;

const server = http.createServer(app);

const startServer = async () => {
    try {
        // Initialize Redis Connection
        await initRedis();

        // Initialize Socket.io after Redis is connected (so the Redis Adapter can bind)
        initSocket(server);

        // Start real-time presence verifier background worker
        const { startPresenceWorker } = require("./src/services/presenceWorker.service");
        startPresenceWorker(15);

        // Connect to MongoDB
        await connectDB();

        server.listen(PORT, () => {
            console.log(`🚀 Server Running on Port ${PORT} with Socket.io Enabled`);
        });

    } catch (error) {
        console.log(error);
        process.exit(1);
    }
};

startServer();