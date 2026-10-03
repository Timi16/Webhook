import { loadEnv } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createLogger } from "./lib/logger.js";

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);

await prisma.$connect();
// The ingestion, reconciliation, watchdog and dispatcher loops start here from Phase 1 onwards.
logger.info("webhook-worker started");

const keepAlive = setInterval(() => {}, 60_000);

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  clearInterval(keepAlive);
  prisma
    .$disconnect()
    .catch((err: unknown) => logger.error({ err }, "error disconnecting from database"))
    .finally(() => process.exit(0));
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
