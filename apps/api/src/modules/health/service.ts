import type { HealthResponse } from "@webhook/shared";
import type { HealthRepo } from "./repo.js";

const DB_TIMEOUT_MS = 3_000;
const MAX_HEALTHY_LAG_SECONDS = 60;

export interface HealthResult {
  httpStatus: 200 | 503;
  body: HealthResponse;
}

export interface HealthService {
  check(): Promise<HealthResult>;
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("health check timed out")), ms).unref();
  });
}

export function createHealthService(
  repo: HealthRepo,
  options: { now?: () => Date; dbTimeoutMs?: number } = {},
): HealthService {
  const now = options.now ?? (() => new Date());
  const dbTimeoutMs = options.dbTimeoutMs ?? DB_TIMEOUT_MS;

  return {
    async check() {
      const at = now();
      try {
        const { cursor, dueDeliveries } = await Promise.race([
          repo.snapshot(at),
          timeout(dbTimeoutMs),
        ]);
        // The worker saves the cursor on every poll, so its age is the ingestion lag.
        const lagSeconds = cursor
          ? Math.max(0, Math.floor((at.getTime() - cursor.updatedAt.getTime()) / 1000))
          : null;
        const lagging = lagSeconds !== null && lagSeconds > MAX_HEALTHY_LAG_SECONDS;
        return {
          httpStatus: 200,
          body: {
            status: lagging ? "degraded" : "ok",
            db: true,
            lastLedger: cursor?.ledger ?? null,
            lagSeconds,
            dueDeliveries,
          },
        };
      } catch {
        return {
          httpStatus: 503,
          body: {
            status: "degraded",
            db: false,
            lastLedger: null,
            lagSeconds: null,
            dueDeliveries: null,
          },
        };
      }
    },
  };
}
