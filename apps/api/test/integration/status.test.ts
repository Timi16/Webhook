import { statusResponse } from "@webhook/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { PrismaClient } from "../../src/db/prisma.js";
import { createLogger } from "../../src/lib/logger.js";
import { createStatusRepo, type CheckResult } from "../../src/modules/status/repo.js";
import { createStatusService, dayState } from "../../src/modules/status/service.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { seedDeveloper, seedEndpoint } from "../helpers/seed.js";
import { testEnv } from "../helpers/testEnv.js";

const env = testEnv();
const logger = createLogger(env);
const DAY_MS = 24 * 60 * 60 * 1000;

let db: TestDb;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await createTestDb();
  prisma = db.prisma;
});
afterAll(async () => {
  await db.cleanup();
});
beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "StatusDay", "Cursor", "Developer" CASCADE`;
});

describe("status page", () => {
  it("classifies a day by how its checks went", () => {
    expect(dayState({ ok: 0, degraded: 0, down: 0 })).toBe("no_data");
    expect(dayState({ ok: 1440, degraded: 0, down: 0 })).toBe("operational");
    expect(dayState({ ok: 1430, degraded: 10, down: 0 })).toBe("degraded");
    expect(dayState({ ok: 1435, degraded: 0, down: 5 })).toBe("partial_outage");
    expect(dayState({ ok: 1300, degraded: 0, down: 140 })).toBe("major_outage");
  });

  it("with no history, every day has no data and everything is operational now", async () => {
    const res = await request(buildApp({ env, logger, prisma })).get("/status");
    expect(res.status).toBe(200);
    const body = statusResponse.parse(res.body);
    expect(body.status).toBe("operational");
    expect(body.components.map((c) => c.key)).toEqual(["api", "detection", "delivery"]);
    for (const component of body.components) {
      expect(component.days).toHaveLength(90);
      expect(component.days.every((d) => d.status === "no_data" && d.uptimePercent === null)).toBe(
        true,
      );
      expect(component.uptimePercent).toBeNull();
    }
    expect(body.components[0]!.days.at(-1)!.date).toBe(new Date().toISOString().slice(0, 10));
  });

  it("counts each minute's check into its UTC day and reports uptime from the counts", async () => {
    let at = new Date("2026-10-04T10:00:00Z");
    let api: CheckResult = "ok";
    const service = createStatusService(createStatusRepo(prisma), {
      now: () => at,
      checkApi: async () => api,
    });
    // Yesterday: 9 good checks and 1 where the API did not answer.
    at = new Date("2026-10-03T23:50:00Z");
    for (let i = 0; i < 9; i++) await service.sample();
    api = "down";
    await service.sample();
    // Today: 4 good checks.
    api = "ok";
    at = new Date("2026-10-04T10:00:00Z");
    for (let i = 0; i < 4; i++) await service.sample();

    const body = await service.get();
    const apiComponent = body.components.find((c) => c.key === "api")!;
    expect(apiComponent.days.at(-1)).toEqual({
      date: "2026-10-04",
      status: "operational",
      uptimePercent: 100,
    });
    expect(apiComponent.days.at(-2)).toEqual({
      date: "2026-10-03",
      status: "major_outage",
      uptimePercent: 90,
    });
    expect(apiComponent.days.at(-3)!.status).toBe("no_data");
    expect(apiComponent.uptimePercent).toBe(92.85); // 13 of 14, never rounded up
    const detection = body.components.find((c) => c.key === "detection")!;
    expect(detection.uptimePercent).toBe(100);
    expect(detection.days.at(-2)!.status).toBe("operational");
  });

  it("shows detection and delivery as slow or down when they fall behind", async () => {
    const now = new Date();
    const service = createStatusService(createStatusRepo(prisma), { now: () => now });
    const state = async (key: string) =>
      (await service.get()).components.find((c) => c.key === key)!.status;

    await prisma.cursor.create({
      data: { name: "rpc-events", ledger: 1, networkPassphrase: env.NETWORK_PASSPHRASE },
    });
    expect(await state("detection")).toBe("operational");
    await prisma.$executeRaw`UPDATE "Cursor" SET "updatedAt" = ${new Date(now.getTime() - 120_000)}`;
    expect(await state("detection")).toBe("degraded");
    await prisma.$executeRaw`UPDATE "Cursor" SET "updatedAt" = ${new Date(now.getTime() - 600_000)}`;
    expect(await state("detection")).toBe("outage");
    expect((await service.get()).status).toBe("outage");
    expect((await service.sample()).detection).toBe("down");

    const developer = await seedDeveloper(prisma);
    const endpoint = await seedEndpoint(prisma, developer.id);
    const event = await prisma.webhookEvent.create({
      data: { id: "evt_status", developerId: developer.id, type: "test.ping", payload: {} },
    });
    const delivery = await prisma.delivery.create({
      data: {
        eventId: event.id,
        endpointId: endpoint.id,
        nextAttemptAt: new Date(now.getTime() - 2 * 60_000),
      },
    });
    expect(await state("delivery")).toBe("degraded");
    // Waiting behind a disabled endpoint is not lateness.
    await prisma.endpoint.update({ where: { id: endpoint.id }, data: { status: "DISABLED" } });
    expect(await state("delivery")).toBe("operational");
    await prisma.delivery.delete({ where: { id: delivery.id } });
  });

  it("drops history older than it shows", async () => {
    const repo = createStatusRepo(prisma);
    const now = new Date("2026-10-04T00:00:30Z");
    await repo.record(
      { api: "ok", detection: "ok", delivery: "ok" },
      new Date(now.getTime() - 130 * DAY_MS),
    );
    await repo.record(
      { api: "ok", detection: "ok", delivery: "ok" },
      new Date(now.getTime() - 10 * DAY_MS),
    );
    await createStatusService(repo, { now: () => now }).sample(); // the midnight pass prunes
    expect(await prisma.statusDay.count()).toBe(6);
  });
});
