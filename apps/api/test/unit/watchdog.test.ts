import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { Watchdog } from "../../src/engine/watchdog.js";
import { createLogger } from "../../src/lib/logger.js";
import { FakeSource } from "../helpers/fakeSource.js";

const logger = createLogger({ NODE_ENV: "test", LOG_LEVEL: "silent" });

function fakePrisma(cursorLedger: number): PrismaClient {
  return {
    cursor: { findUnique: async () => ({ ledger: cursorLedger, pagingToken: null }) },
    delivery: { count: async () => 0 },
    $queryRaw: async () => [{ endpoints: 0, total: 0, failed: 0 }],
  } as unknown as PrismaClient;
}

describe("watchdog", () => {
  it("exits the process when the ingestion heartbeat is older than 60 s", async () => {
    const exit = vi.fn();
    const watchdog = new Watchdog({
      prisma: fakePrisma(1000),
      source: new FakeSource(),
      alert: async () => {},
      logger,
      getHeartbeat: () => 0,
      now: () => 61_000,
      exit,
    });
    await watchdog.check();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("alerts once when lag stays above 12 ledgers for 2 minutes, and not before", async () => {
    const alert = vi.fn(async (_message: string) => {});
    let now = 0;
    const source = new FakeSource();
    source.tip = 1013;
    const watchdog = new Watchdog({
      prisma: fakePrisma(1000),
      source,
      alert,
      logger,
      getHeartbeat: () => now,
      now: () => now,
      exit: vi.fn(),
    });

    await watchdog.check();
    now = 119_000;
    await watchdog.check();
    expect(alert).not.toHaveBeenCalled();

    now = 121_000;
    await watchdog.check();
    now = 136_000;
    await watchdog.check();
    expect(alert).toHaveBeenCalledOnce();
    expect(alert.mock.calls[0]?.[0]).toContain("13 ledgers behind");
  });

  it("does not alert when the lag recovers", async () => {
    const alert = vi.fn(async (_message: string) => {});
    let now = 0;
    const source = new FakeSource();
    source.tip = 1050;
    const watchdog = new Watchdog({
      prisma: fakePrisma(1000),
      source,
      alert,
      logger,
      getHeartbeat: () => now,
      now: () => now,
      exit: vi.fn(),
    });
    await watchdog.check();
    source.tip = 1005;
    now = 100_000;
    await watchdog.check();
    source.tip = 1050;
    now = 130_000;
    await watchdog.check();
    expect(alert).not.toHaveBeenCalled();
  });
});
