import { rpc } from "@stellar/stellar-sdk";
import { loadEnv } from "./config/env.js";
import { CHANNELS, PgListener } from "./db/notify.js";
import { createPrismaClient } from "./db/prisma.js";
import { Dispatcher } from "./delivery/dispatcher.js";
import { createSafeHttpClient } from "./delivery/safeHttp.js";
import { Ingestion } from "./engine/ingestion.js";
import { handleNetworkReset } from "./engine/networkReset.js";
import { reconcile, RECONCILIATION_INTERVAL_MS } from "./engine/reconciliation.js";
import { HorizonBackfillSource } from "./engine/sources/horizonBackfill.js";
import { RpcEventSource } from "./engine/sources/rpcEventSource.js";
import { runPendingBackfills } from "./engine/watchBackfill.js";
import { Watchdog, WATCHDOG_INTERVAL_MS } from "./engine/watchdog.js";
import { WatchedSet } from "./engine/watchedSet.js";
import { createAlerter } from "./lib/alert.js";
import { createLogger } from "./lib/logger.js";
import { createMailer } from "./lib/mailer.js";
import { createStatusRepo, type CheckResult } from "./modules/status/repo.js";
import { createStatusService } from "./modules/status/service.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;
const STATUS_SAMPLE_INTERVAL_MS = 60_000;

const env = loadEnv();
const logger = createLogger(env);
const prisma = createPrismaClient(env.DATABASE_URL);
const alert = createAlerter(env, logger);
const listener = new PgListener(env.DATABASE_URL, logger);

const watchedSet = new WatchedSet(prisma, logger);
const horizonBackfill = new HorizonBackfillSource(env.HORIZON_URL);
const source = new RpcEventSource(
  new rpc.Server(env.STELLAR_RPC_URL, { allowHttp: env.NODE_ENV !== "production" }),
  env.NETWORK_PASSPHRASE,
  () => watchedSet.wallets(),
  (txHash) => horizonBackfill.transactionEnvelope(txHash),
);
const ingestion = new Ingestion({
  prisma,
  source,
  backfill: horizonBackfill,
  watchedSet,
  networkPassphrase: env.NETWORK_PASSPHRASE,
  logger,
  onNetworkReset: (tip) =>
    handleNetworkReset({ prisma, networkPassphrase: env.NETWORK_PASSPHRASE, alert, logger }, tip),
});
const http = createSafeHttpClient({ allowInsecure: env.ALLOW_INSECURE_WEBHOOK_TARGETS === "true" });
const dispatcher = new Dispatcher({
  prisma,
  http,
  env,
  logger,
  mailer: createMailer(env, logger),
  maxInFlight: env.MAX_CONCURRENT_DELIVERIES,
});
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
// Watches created with backfillHours carry a backfillPending flag until their history has been
// replayed, so the request survives a restart. Backfills run one at a time, never overlapping.
let backfilling = false;
function runBackfills(): void {
  if (backfilling) return;
  backfilling = true;
  runPendingBackfills({
    prisma,
    watchedSet,
    logger,
    backfillWallet: (wallet, from, to) => ingestion.backfillWallet(wallet, from, to),
  })
    .catch((err: unknown) => logger.error({ err }, "watch backfills failed"))
    .finally(() => {
      backfilling = false;
    });
}
listener.on(CHANNELS.watchesChanged, runBackfills);
const backfillTimer = setInterval(runBackfills, 30_000);
await listener.start();
runBackfills(); // anything requested while the worker was down

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

// Uptime history for the status page: once a minute, check each part of the service and count it.
const statusService = createStatusService(createStatusRepo(prisma), {
  // The API is a separate process; it is up if its health check answers.
  checkApi: async (): Promise<CheckResult> => {
    try {
      const res = await fetch(`http://127.0.0.1:${env.PORT}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok ? "ok" : "down";
    } catch {
      return "down";
    }
  },
});
const sampleStatus = () =>
  statusService
    .sample()
    .catch((err: unknown) => logger.error({ err }, "status sample failed"));
const statusTimer = setInterval(() => void sampleStatus(), STATUS_SAMPLE_INTERVAL_MS);
void sampleStatus();

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
  clearInterval(backfillTimer);
  clearInterval(statusTimer);
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
