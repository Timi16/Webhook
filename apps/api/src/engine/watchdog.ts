import type { PrismaClient } from "@prisma/client";
import type { Alerter } from "../lib/alert.js";
import type { Logger } from "../lib/logger.js";
import { loadCursor } from "./cursor.js";
import type { StellarSource } from "./types.js";

export const WATCHDOG_INTERVAL_MS = 15_000;
const MAX_LAG_LEDGERS = 12; // about 60 s
const LAG_ALERT_AFTER_MS = 120_000;
const STALE_HEARTBEAT_MS = 60_000;
const MAX_DUE_DELIVERIES = 1_000;
const ALERT_COOLDOWN_MS = 15 * 60_000;

export interface WatchdogDeps {
  prisma: PrismaClient;
  source: StellarSource;
  alert: Alerter;
  logger: Logger;
  getHeartbeat: () => number;
  exit?: (code: number) => void;
  now?: () => number;
}

export class Watchdog {
  private laggingSince: number | undefined;
  private readonly lastAlert = new Map<string, number>();

  constructor(private readonly deps: WatchdogDeps) {}

  async check(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();

    // A wedged main loop cannot recover by itself: exit so Docker restarts the worker.
    if (now - this.deps.getHeartbeat() > STALE_HEARTBEAT_MS) {
      this.deps.logger.fatal("ingestion heartbeat is stale, exiting for a restart");
      (this.deps.exit ?? process.exit)(1);
      return;
    }

    try {
      const [tip, cursor] = await Promise.all([
        this.deps.source.latestLedger(),
        loadCursor(this.deps.prisma),
      ]);
      const lag = cursor ? tip - cursor.ledger : 0;
      if (lag > MAX_LAG_LEDGERS) {
        this.laggingSince ??= now;
        if (now - this.laggingSince >= LAG_ALERT_AFTER_MS) {
          await this.alertOnce("lag", now, `Ingestion is ${lag} ledgers behind the testnet tip.`);
        }
      } else {
        this.laggingSince = undefined;
      }
    } catch (err) {
      this.laggingSince ??= now;
      if (now - this.laggingSince >= LAG_ALERT_AFTER_MS) {
        const reason = err instanceof Error ? err.message : String(err);
        await this.alertOnce("lag", now, `Cannot reach Stellar RPC or the database: ${reason}`);
      }
    }

    await this.checkDeliveries(now).catch((err: unknown) => {
      this.deps.logger.error({ err }, "watchdog delivery check failed");
    });
  }

  private async checkDeliveries(now: number): Promise<void> {
    const due = await this.deps.prisma.delivery.count({
      where: { status: { in: ["PENDING", "RETRYING"] }, nextAttemptAt: { lte: new Date(now) } },
    });
    if (due > MAX_DUE_DELIVERIES)
      await this.alertOnce("due", now, `${due} deliveries are due and waiting.`);

    const [stats] = await this.deps.prisma.$queryRaw<
      { endpoints: number; total: number; failed: number }[]
    >`
      SELECT count(DISTINCT d."endpointId")::int AS endpoints,
             count(*)::int AS total,
             (count(*) FILTER (WHERE a."statusCode" IS NULL OR a."statusCode" NOT BETWEEN 200 AND 299))::int AS failed
      FROM "DeliveryAttempt" a
      JOIN "Delivery" d ON d.id = a."deliveryId"
      WHERE a."createdAt" > now() - interval '15 minutes'`;
    if (stats && stats.endpoints >= 3 && stats.failed * 2 > stats.total) {
      await this.alertOnce(
        "failures",
        now,
        `${stats.failed} of ${stats.total} delivery attempts failed across ${stats.endpoints} endpoints in 15 min.`,
      );
    }
  }

  private async alertOnce(key: string, now: number, message: string): Promise<void> {
    const last = this.lastAlert.get(key);
    if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return;
    this.lastAlert.set(key, now);
    await this.deps.alert(message);
  }
}
