import { describe, expect, it } from "vitest";
import type { HealthRepo } from "../../src/modules/health/repo.js";
import { createHealthService } from "../../src/modules/health/service.js";

const NOW = new Date("2026-10-03T12:00:00Z");
const now = () => NOW;

function repoReturning(secondsSinceCursor: number | null, dueDeliveries = 0): HealthRepo {
  return {
    snapshot: async () => ({
      cursor:
        secondsSinceCursor === null
          ? null
          : { ledger: 1234, updatedAt: new Date(NOW.getTime() - secondsSinceCursor * 1000) },
      dueDeliveries,
    }),
  };
}

describe("health service", () => {
  it("is ok with no cursor yet (worker has never run)", async () => {
    const result = await createHealthService(repoReturning(null), { now }).check();
    expect(result).toEqual({
      httpStatus: 200,
      body: { status: "ok", db: true, lastLedger: null, lagSeconds: null, dueDeliveries: 0 },
    });
  });

  it("reports the last ledger, lag and due deliveries", async () => {
    const result = await createHealthService(repoReturning(4, 7), { now }).check();
    expect(result.body).toEqual({
      status: "ok",
      db: true,
      lastLedger: 1234,
      lagSeconds: 4,
      dueDeliveries: 7,
    });
  });

  it("is degraded but still 200 when ingestion lags more than 60 s", async () => {
    const result = await createHealthService(repoReturning(61), { now }).check();
    expect(result.httpStatus).toBe(200);
    expect(result.body.status).toBe("degraded");
  });

  it("returns 503 when the database query fails", async () => {
    const repo: HealthRepo = { snapshot: () => Promise.reject(new Error("connection refused")) };
    const result = await createHealthService(repo, { now }).check();
    expect(result.httpStatus).toBe(503);
    expect(result.body).toMatchObject({ status: "degraded", db: false });
  });

  it("returns 503 when the database does not answer in time", async () => {
    const repo: HealthRepo = { snapshot: () => new Promise(() => {}) };
    const result = await createHealthService(repo, { now, dbTimeoutMs: 20 }).check();
    expect(result.httpStatus).toBe(503);
  });
});
