import { rpc } from "@stellar/stellar-sdk";
import { loadEnv } from "./config/env.js";
import { CHANNELS, PgListener } from "./db/notify.js";
import { createPrismaClient } from "./db/prisma.js";
import { Dispatcher } from "./delivery/dispatcher.js";
import { createSafeHttpClient } from "./delivery/safeHttp.js";
import { loadCursor } from "./engine/cursor.js";
import { Ingestion } from "./engine/ingestion.js";
import { handleNetworkReset } from "./engine/networkReset.js";
import { reconcile, RECONCILIATION_INTERVAL_MS } from "./engine/reconciliation.js";
import { HorizonBackfillSource } from "./engine/sources/horizonBackfill.js";
import { RpcEventSource } from "./engine/sources/rpcEventSource.js";
import { Watchdog, WATCHDOG_INTERVAL_MS } from "./engine/watchdog.js";
import { WatchedSet } from "./engine/watchedSet.js";
import { createAlerter } from "./lib/alert.js";
import { createLogger } from "./lib/logger.js";
import { createMailer } from "./lib/mailer.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);
const alert = createAlerter(env, logger);
const listener = new PgListener(env.DATABASE_URL, logger);

const watchedSet = new WatchedSet(prisma, logger);
const source = new RpcEventSource(
  new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: env.NODE_ENV !== "production" }),
  env.NETWORK_PASSPHRASE,
  () => watchedSet.wallets(),
);
const ingestion = new Ingestion({
  prisma,
  source,
  backfill: new HorizonBackfillSource(env.HORIZON_URL),
  watchedSet,
  networkPassphrase: env.NETWORK_PASSPHRASE,
  logger,
  onNetworkReset: (tip) =>
    handleNetworkReset({ prisma, networkPassphrase: env.NETWORK_PASSPHRASE, alert, logger }, tip),
});
const http = createSafeHttpClient({ allowInsecure: env.ALLOW_INSECURE_WEBHOOK_TARGETS === "true" });
const dispatcher = new Dispatcher({ prisma, http, env, logger, mailer: createMailer(env, logger) });
const watchdog = new Watchdog({
  prisma,
  source,
  alert,
  logger,
  getHeartbeat: () => ingestion.heartbeat,
});

await prisma.$connect();
await watchedSet.reload();
watchedSet.start(listener);
listener.on(CHANNELS.deliveries, () => dispatcher.wake());
// A watch created with backfillHours: replay that wallet's history up to where the live loop is.
listener.on(CHANNELS.watchBackfill, (payload) => {
  const { wallet, fromLedger } = payload;
  if (typeof wallet !== "string" || typeof fromLedger !== "number") return;
  void (async () => {
    await watchedSet.reload();
    const cursor = await loadCursor(prisma);
    if (cursor) await ingestion.backfillWallet(wallet, fromLedger, cursor.ledger + 1);
  })().catch((err: unknown) => logger.error({ err, wallet }, "watch backfill failed"));
});
await listener.start();

const controller = new AbortController();
const loops = [ingestion.run(controller.signal), dispatcher.run(controller.signal)];

let reconciling = false;
const reconciliationTimer = setInterval(() => {
  if (reconciling) return; // the previous run is still going
  reconciling = true;
  reconcile({ prisma, source, watchedSet, logger })
    .catch((err: unknown) => logger.error({ err }, "reconciliation failed"))
    .finally(() => {
      reconciling = false;
    });
}, RECONCILIATION_INTERVAL_MS);
const watchdogTimer = setInterval(() => {
  watchdog.check().catch((err: unknown) => logger.error({ err }, "watchdog check failed"));
}, WATCHDOG_INTERVAL_MS);

logger.info(
  { wallets: watchedSet.size, insecureTargets: env.ALLOW_INSECURE_WEBHOOK_TARGETS === "true" },
  "webhook-worker started",
);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  // Stop claiming new work, give in-flight sends up to 10 s; the rest is re-claimed after its lease.
  controller.abort();
  clearInterval(reconciliationTimer);
  clearInterval(watchdogTimer);
  watchedSet.stop();
  const force = setTimeout(() => process.exit(0), SHUTDOWN_TIMEOUT_MS + 2_000);
  force.unref();
  await Promise.allSettled(loops);
  await dispatcher.drain(SHUTDOWN_TIMEOUT_MS);
  await listener.stop();
  await http.close();
  await prisma
    .$disconnect()
    .catch((err: unknown) => logger.error({ err }, "error disconnecting from database"));
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
