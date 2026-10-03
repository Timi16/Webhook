import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createPrismaClient } from "./db/prisma.js";
import { createLogger } from "./lib/logger.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);
const app = buildApp({ env, logger, prisma });

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "webhook-api listening");
});

let shuttingDown = false;

function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");

  const force = setTimeout(() => {
    logger.warn("in-flight requests did not finish in time, closing connections");
    server.closeAllConnections();
  }, SHUTDOWN_TIMEOUT_MS);
  force.unref();

  server.close(() => {
    clearTimeout(force);
    prisma
      .$disconnect()
      .catch((err: unknown) => logger.error({ err }, "error disconnecting from database"))
      .finally(() => process.exit(0));
  });
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
