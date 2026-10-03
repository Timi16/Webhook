import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { createPrismaClient, type PrismaClient } from "../../src/db/prisma.js";
import { createTestDb, type TestDb } from "../helpers/db.js";
import { createLogger } from "../../src/lib/logger.js";
import { testEnv } from "../helpers/testEnv.js";

const env = testEnv();
const logger = createLogger(env);

describe("GET /health", () => {
  let db: TestDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    prisma = db.prisma;
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it("returns 200 with DB status on a fresh database", async () => {
    const res = await request(buildApp({ env, logger, prisma })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "ok",
      db: true,
      lastLedger: null,
      lagSeconds: null,
      dueDeliveries: 0,
    });
  });

  it("reports the cursor ledger once the worker has saved one", async () => {
    await prisma.cursor.create({
      data: { name: "rpc-events", ledger: 4242, networkPassphrase: env.NETWORK_PASSPHRASE },
    });
    try {
      const res = await request(buildApp({ env, logger, prisma })).get("/health");
      expect(res.body).toMatchObject({ status: "ok", db: true, lastLedger: 4242 });
      expect(res.body.lagSeconds).toBeGreaterThanOrEqual(0);
    } finally {
      await prisma.cursor.delete({ where: { name: "rpc-events" } });
    }
  });

  it("returns 503 when the database is unreachable", async () => {
    const dead = createPrismaClient("postgresql://webhook:webhook@127.0.0.1:1/webhooks");
    try {
      const res = await request(buildApp({ env, logger, prisma: dead })).get("/health");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ status: "degraded", db: false });
    } finally {
      await dead.$disconnect();
    }
  });
});

describe("app skeleton", () => {
  let db: TestDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    db = await createTestDb();
    prisma = db.prisma;
  });

  afterAll(async () => {
    await db.cleanup();
  });

  it("generates a request ID and echoes it on the response", async () => {
    const res = await request(buildApp({ env, logger, prisma })).get("/health");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("reuses a safe incoming X-Request-Id and replaces an unsafe one", async () => {
    const app = buildApp({ env, logger, prisma });
    const kept = await request(app).get("/health").set("X-Request-Id", "abc-123");
    expect(kept.headers["x-request-id"]).toBe("abc-123");
    const replaced = await request(app).get("/health").set("X-Request-Id", "bad id!");
    expect(replaced.headers["x-request-id"]).not.toBe("bad id!");
  });

  it("returns the shared error shape for unknown routes", async () => {
    const res = await request(buildApp({ env, logger, prisma })).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Resource not found",
        requestId: res.headers["x-request-id"],
      },
    });
  });

  it("returns VALIDATION_FAILED for malformed JSON", async () => {
    const res = await request(buildApp({ env, logger, prisma }))
      .post("/nope")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("sets hardening headers and hides x-powered-by", async () => {
    const res = await request(buildApp({ env, logger, prisma })).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["strict-transport-security"]).toContain("max-age=");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("rate limits an IP after 60 requests a minute with Retry-After", async () => {
    const app = buildApp({ env, logger, prisma });
    for (let i = 0; i < 60; i++) await request(app).get("/nope");
    const res = await request(app).get("/nope");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
