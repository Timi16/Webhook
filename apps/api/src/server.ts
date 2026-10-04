import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { PgListener } from "./db/notify.js";
import { createPrismaClient } from "./db/prisma.js";
import { createLogger } from "./lib/logger.js";
import type { StreamHub } from "./modules/stream/service.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);
// One LISTEN connection for the whole process; the SSE hub fans out from it.
const listener = new PgListener(env.DATABASE_URL, logger);
const app = buildApp({ env, logger, prisma, listener });
await listener.start();

// Behind a reverse proxy the API listens on loopback only, so the proxy is the only way in.
const host = env.HOST ?? (env.NODE_ENV === "production" ? "127.0.0.1" : undefined);
const onListening = () =>
  logger.info({ port: env.PORT, host: host ?? "all" }, "webhook-api listening");
const server = host ? app.listen(env.PORT, host, onListening) : app.listen(env.PORT, onListening);

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

  // Stop accepting connections, end SSE streams, wait for in-flight requests, then disconnect.
  server.close(() => {
    clearTimeout(force);
    Promise.allSettled([listener.stop(), prisma.$disconnect()]).finally(() => process.exit(0));
  });
  (app.locals.streamHub as StreamHub).closeAll();
  server.closeIdleConnections();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
