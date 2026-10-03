import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { PrismaClient } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNELS } from "../../src/db/notify.js";
import { sha256Hex } from "../../src/lib/ids.js";
import type { StreamHub } from "../../src/modules/stream/service.js";
import { generateOpenApiDocument } from "../../src/openapi/registry.js";
import { makeTestApp, ORIGIN, PASSWORD, type TestApp, type TestSession } from "../helpers/app.js";
import { createTestDb, waitFor, type TestDb } from "../helpers/db.js";
import { makePayment, randomAddress, USDC, USDC_ISSUER, XLM } from "../helpers/payments.js";
import { processPayment } from "../../src/engine/matcher.js";
import { parseWatch } from "../../src/engine/watch.js";

let db: TestDb;
let prisma: PrismaClient;
let t: TestApp;
let alice: TestSession;
let aliceKey: string;

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

beforeAll(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  t = makeTestApp(db);
  alice = await t.signup();
  aliceKey = (await alice.createApiKey()).key;
});

afterAll(async () => {
  await db.cleanup();
});

async function createEndpoint(key = aliceKey, url = "https://hooks.example.com/stellar") {
  const res = await request(t.app).post("/v1/endpoints").set(bearer(key)).send({ url });
  expect(res.status).toBe(201);
  return res.body as { endpoint: { id: string; url: string; status: string }; secret: string };
}

async function createWatch(endpointId: string, body: Record<string, unknown> = {}, key = aliceKey) {
  const res = await request(t.app)
    .post("/v1/watches")
    .set(bearer(key))
    .send({ walletAddress: randomAddress(), endpointId, assets: [USDC], ...body });
  expect(res.status).toBe(201);
  return res.body as {
    watch: { id: string; walletAddress: string; startLedger: number; active: boolean };
    warnings: string[];
  };
}

/** Runs a payment through the real matcher for the given watch. */
async function pay(watchId: string, overrides: Parameters<typeof makePayment>[0] = {}) {
  const row = await prisma.watch.findUniqueOrThrow({ where: { id: watchId } });
  const payment = makePayment({ to: row.walletAddress, ledger: row.startLedger + 1, ...overrides });
  await prisma.$transaction((tx) => processPayment(tx, payment, [parseWatch(row)]));
  return payment;
}

describe("auth", () => {
  it("signs up, sets an httpOnly SameSite=Lax session cookie and stores only its hash", async () => {
    const res = await request(t.app)
      .post("/auth/signup")
      .set("Origin", ORIGIN)
      .send({ email: "  New.Dev@Example.com ", password: PASSWORD, name: "New Dev" });
    expect(res.status).toBe(201);
    expect(res.body.developer).toMatchObject({ email: "new.dev@example.com", name: "New Dev" });
    expect(res.body.developer.passwordHash).toBeUndefined();
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookie).toMatch(/^whk_session=/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    const token = cookie.split(";")[0]!.slice("whk_session=".length);
    expect(t.logs()).toContain("/auth/signup");
    expect(t.logs()).not.toContain(token); // the Set-Cookie header is redacted in request logs
    expect(t.logs()).toContain('"set-cookie":"[redacted]"');
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sha256Hex(token) } });
    expect(session.developerId).toBe(res.body.developer.id);
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(13.9 * 24 * 3600 * 1000);
    const developer = await prisma.developer.findUniqueOrThrow({
      where: { id: res.body.developer.id },
    });
    expect(developer.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("rejects duplicate emails, short passwords, common passwords and unknown fields", async () => {
    const post = (body: object) =>
      request(t.app).post("/auth/signup").set("Origin", ORIGIN).send(body);
    expect((await post({ email: alice.email, password: PASSWORD })).status).toBe(409);
    const short = await post({ email: "short@example.com", password: "short" });
    expect(short.status).toBe(400);
    expect(short.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "password", issue: "password_too_short" }],
    });
    const common = await post({ email: "common@example.com", password: "Password123" });
    expect(common.body.error.details).toEqual([{ path: "password", issue: "password_too_common" }]);
    const extra = await post({ email: "extra@example.com", password: PASSWORD, admin: true });
    expect(extra.status).toBe(400);
  });

  it("gives the same error for a wrong password and an unknown email", async () => {
    const login = (email: string, password: string) =>
      request(t.app).post("/auth/login").set("Origin", ORIGIN).send({ email, password });
    const wrongPassword = await login(alice.email, "not the password");
    const unknownEmail = await login("nobody@example.com", PASSWORD);
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it("logs in with a rotated session, returns /auth/me and logs out", async () => {
    const dev = await t.signup();
    const login = await request(t.app)
      .post("/auth/login")
      .set("Origin", ORIGIN)
      .set("Cookie", dev.cookie)
      .send({ email: dev.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const cookie = (login.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    expect(cookie).not.toBe(dev.cookie);
    // The old session was rotated away.
    expect((await request(t.app).get("/auth/me").set("Cookie", dev.cookie)).status).toBe(401);
    const me = await request(t.app).get("/auth/me").set("Cookie", cookie);
    expect(me.body.developer.email).toBe(dev.email);

    const logout = await request(t.app)
      .post("/auth/logout")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie);
    expect(logout.status).toBe(204);
    expect((await request(t.app).get("/auth/me").set("Cookie", cookie)).status).toBe(401);
  });

  it("requires a matching Origin on state-changing cookie requests (CSRF)", async () => {
    const noOrigin = await request(t.app)
      .post("/v1/api-keys")
      .set("Cookie", alice.cookie)
      .send({ name: "x" });
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.error.code).toBe("FORBIDDEN_ORIGIN");
    const evil = await request(t.app)
      .post("/v1/api-keys")
      .set("Cookie", alice.cookie)
      .set("Origin", "https://evil.example.com")
      .send({ name: "x" });
    expect(evil.status).toBe(403);
    expect(
      (await request(t.app).post("/auth/login").send({ email: alice.email, password: PASSWORD }))
        .status,
    ).toBe(403);
    // API keys are not cookies: no Origin needed.
    expect(
      (
        await request(t.app)
          .post("/v1/endpoints")
          .set(bearer(aliceKey))
          .send({ url: "https://a.example.com" })
      ).status,
    ).toBe(201);
  });

  it("changing the password deletes every other session", async () => {
    const dev = await t.signup();
    const second = await request(t.app)
      .post("/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: dev.email, password: PASSWORD });
    const otherCookie = (second.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;

    const wrong = await request(t.app)
      .post("/auth/password")
      .set("Origin", ORIGIN)
      .set("Cookie", dev.cookie)
      .send({ currentPassword: "nope nope nope", newPassword: "a brand new passphrase" });
    expect(wrong.status).toBe(400);

    const changed = await request(t.app)
      .post("/auth/password")
      .set("Origin", ORIGIN)
      .set("Cookie", dev.cookie)
      .send({ currentPassword: PASSWORD, newPassword: "a brand new passphrase" });
    expect(changed.status).toBe(204);
    expect((await request(t.app).get("/auth/me").set("Cookie", dev.cookie)).status).toBe(200);
    expect((await request(t.app).get("/auth/me").set("Cookie", otherCookie)).status).toBe(401);
  });

  it("forgot always returns 204; the emailed token resets the password once", async () => {
    const dev = await t.signup();
    const forgot = (email: string) =>
      request(t.app).post("/auth/forgot").set("Origin", ORIGIN).send({ email });
    expect((await forgot("nobody@example.com")).status).toBe(204);
    const before = t.mails.length;
    expect((await forgot(dev.email)).status).toBe(204);
    expect(t.mails).toHaveLength(before + 1);
    const token = /token=([\w.-]+)/.exec(t.mails.at(-1)!.text)![1]!;

    const reset = (tok: string) =>
      request(t.app)
        .post("/auth/reset")
        .set("Origin", ORIGIN)
        .send({ token: tok, newPassword: "freshly reset password" });
    expect((await reset(`${token}00`)).status).toBe(400);
    expect((await reset(token)).status).toBe(204);
    expect((await reset(token)).status).toBe(400); // the hash changed, so the token is dead
    expect((await request(t.app).get("/auth/me").set("Cookie", dev.cookie)).status).toBe(401);
    const login = await request(t.app)
      .post("/auth/login")
      .set("Origin", ORIGIN)
      .send({ email: dev.email, password: "freshly reset password" });
    expect(login.status).toBe(200);
  });

  it("limits auth attempts to 5 a minute per IP", async () => {
    const limited = makeTestApp(db, { rateLimits: { global: 1000, auth: 5, api: 1000 } });
    const attempt = () =>
      request(limited.app)
        .post("/auth/login")
        .set("Origin", ORIGIN)
        .send({ email: "x@example.com", password: "whatever it is" });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    const res = await attempt();
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.headers["retry-after"]).toBeDefined();
  });
});

describe("API keys", () => {
  it("shows the key once, lists only the prefix and authenticates with Bearer", async () => {
    const created = await request(t.app)
      .post("/v1/api-keys")
      .set("Cookie", alice.cookie)
      .set("Origin", ORIGIN)
      .send({ name: "ci" });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^whk_test_/);
    expect(created.body.apiKey.prefix).toBe(created.body.key.slice(0, 13));
    const stored = await prisma.apiKey.findUniqueOrThrow({ where: { id: created.body.apiKey.id } });
    expect(stored.keyHash).toBe(sha256Hex(created.body.key));

    const list = await request(t.app).get("/v1/api-keys").set("Cookie", alice.cookie);
    expect(JSON.stringify(list.body)).not.toContain(created.body.key);
    expect(list.body.data.some((k: { id: string }) => k.id === created.body.apiKey.id)).toBe(true);

    expect((await request(t.app).get("/v1/watches").set(bearer(created.body.key))).status).toBe(
      200,
    );
    await waitFor(
      async () => (await prisma.apiKey.findUniqueOrThrow({ where: { id: stored.id } })).lastUsedAt,
    );
  });

  it("is managed by the session only: an API key cannot create or list keys", async () => {
    expect((await request(t.app).get("/v1/api-keys").set(bearer(aliceKey))).status).toBe(401);
    expect(
      (await request(t.app).post("/v1/api-keys").set(bearer(aliceKey)).send({ name: "x" })).status,
    ).toBe(401);
  });

  it("A3: a revoked API key gets 401", async () => {
    const { id, key } = await alice.createApiKey();
    expect((await request(t.app).get("/v1/endpoints").set(bearer(key))).status).toBe(200);
    const revoke = await request(t.app)
      .delete(`/v1/api-keys/${id}`)
      .set("Cookie", alice.cookie)
      .set("Origin", ORIGIN);
    expect(revoke.status).toBe(204);
    const res = await request(t.app).get("/v1/endpoints").set(bearer(key));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHENTICATED");
    // Kept for history.
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id } })).revokedAt).not.toBeNull();
  });

  it("accepts the Bearer scheme in any case", async () => {
    const res = await request(t.app).get("/v1/watches").set("Authorization", `bearer ${aliceKey}`);
    expect(res.status).toBe(200);
  });

  it("answers malformed percent-encoding with 400, not 500", async () => {
    const res = await request(t.app).get("/v1/watches/%E0%A4%A").set(bearer(aliceKey));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("two signups racing for the same email give one account and one 409", async () => {
    const body = { email: "race@example.com", password: PASSWORD };
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(t.app).post("/auth/signup").set("Origin", ORIGIN).send(body),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    expect(await prisma.developer.count({ where: { email: "race@example.com" } })).toBe(1);
  });

  it("A1: a secret key pasted into a query string is rejected and never reaches the logs", async () => {
    const secret = Keypair.random().secret();
    for (const path of ["/v1/watches", "/v1/payments"]) {
      const res = await request(t.app).get(`${path}?wallet=${secret}`).set(bearer(aliceKey));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("SECRET_KEY_REJECTED");
    }
    expect(t.logs()).toContain('"url":"/v1/payments"'); // the path is logged, the query string is not
    expect(t.logs()).not.toContain(secret);
  });

  it("refuses NUL characters with 400 instead of failing in the database", async () => {
    const endpoint = await request(t.app)
      .post("/v1/endpoints")
      .set(bearer(aliceKey))
      .send({ url: "https://nul.example.com", description: "a\u0000b" });
    expect(endpoint.status).toBe(400);
    expect(endpoint.body.error.details).toEqual([{ path: "body", issue: "invalid_character" }]);
    const key = await request(t.app)
      .post("/v1/api-keys")
      .set("Cookie", alice.cookie)
      .set("Origin", ORIGIN)
      .send({ name: "\u0000" });
    expect(key.status).toBe(400);
    expect((await request(t.app).get("/v1/events?watchId=%00").set(bearer(aliceKey))).status).toBe(
      400,
    );
  });

  it("rejects missing, malformed and unknown credentials", async () => {
    expect((await request(t.app).get("/v1/watches")).status).toBe(401);
    expect((await request(t.app).get("/v1/watches").set(bearer("whk_test_nope"))).status).toBe(401);
    // A bad Bearer key is never rescued by a valid cookie.
    expect(
      (await request(t.app).get("/v1/watches").set(bearer("garbage")).set("Cookie", alice.cookie))
        .status,
    ).toBe(401);
  });
});

describe("endpoints", () => {
  it("creates with a whsec_ secret shown once and stored encrypted", async () => {
    const { endpoint, secret } = await createEndpoint();
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({ status: "ACTIVE", url: "https://hooks.example.com/stellar" });
    const row = await prisma.endpoint.findUniqueOrThrow({ where: { id: endpoint.id } });
    expect(row.secretEnc).not.toContain(secret);
    const got = await request(t.app).get(`/v1/endpoints/${endpoint.id}`).set(bearer(aliceKey));
    expect(JSON.stringify(got.body)).not.toContain(secret);
    expect(got.body.endpoint.stats.last24h).toEqual({
      delivered: 0,
      failed: 0,
      retrying: 0,
      pending: 0,
    });
  });

  it("A2: refuses non-HTTPS URLs, credentials in the URL and other ports with INSECURE_URL", async () => {
    for (const url of [
      "http://hooks.example.com/x",
      "https://user:pass@hooks.example.com/x",
      "https://hooks.example.com:8080/x",
      "ftp://hooks.example.com",
      "not a url",
    ]) {
      const res = await request(t.app).post("/v1/endpoints").set(bearer(aliceKey)).send({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe("INSECURE_URL");
    }
    expect(
      (
        await request(t.app)
          .post("/v1/endpoints")
          .set(bearer(aliceKey))
          .send({ url: "https://hooks.example.com:8443/x" })
      ).status,
    ).toBe(201);
  });

  it("D8: refuses URLs that are or resolve to private and internal addresses with SSRF_BLOCKED", async () => {
    for (const url of [
      "https://internal.example.com/hook", // resolves to 10.0.0.5
      "https://127.0.0.1/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://10.1.2.3/hook",
      "https://192.168.1.10/hook",
      "https://100.64.0.1/hook",
      "https://[::1]/hook",
      "https://[::ffff:10.0.0.1]/hook",
      "https://[fd00::1]/hook",
      "https://0.0.0.0/hook",
    ]) {
      const res = await request(t.app).post("/v1/endpoints").set(bearer(aliceKey)).send({ url });
      expect(res.status, url).toBe(400);
      expect(res.body.error.code, url).toBe("SSRF_BLOCKED");
    }
  });

  it("re-checks a changed URL, rotates the secret with a 24 h grace window and re-enables", async () => {
    const { endpoint, secret } = await createEndpoint();
    const bad = await request(t.app)
      .patch(`/v1/endpoints/${endpoint.id}`)
      .set(bearer(aliceKey))
      .send({ url: "https://internal.example.com/x" });
    expect(bad.body.error.code).toBe("SSRF_BLOCKED");
    const ok = await request(t.app)
      .patch(`/v1/endpoints/${endpoint.id}`)
      .set(bearer(aliceKey))
      .send({ url: "https://new.example.com/x", description: "prod" });
    expect(ok.body.endpoint).toMatchObject({
      url: "https://new.example.com/x",
      description: "prod",
    });

    const rotated = await request(t.app)
      .post(`/v1/endpoints/${endpoint.id}/rotate-secret`)
      .set(bearer(aliceKey));
    expect(rotated.body.secret).toMatch(/^whsec_/);
    expect(rotated.body.secret).not.toBe(secret);
    const until = new Date(rotated.body.previousSecretValidUntil).getTime() - Date.now();
    expect(until).toBeGreaterThan(23.9 * 3600 * 1000);
    expect(until).toBeLessThanOrEqual(24 * 3600 * 1000);

    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { status: "DISABLED", disabledReason: "GONE", consecutiveFailures: 20 },
    });
    const enabled = await request(t.app)
      .post(`/v1/endpoints/${endpoint.id}/enable`)
      .set(bearer(aliceKey));
    expect(enabled.body.endpoint).toMatchObject({
      status: "ACTIVE",
      consecutiveFailures: 0,
      disabledReason: null,
    });
  });

  it("refuses to delete an endpoint with active watches; otherwise cancels its unfinished deliveries", async () => {
    const { endpoint } = await createEndpoint();
    const { watch } = await createWatch(endpoint.id);
    await pay(watch.id);
    const blocked = await request(t.app)
      .delete(`/v1/endpoints/${endpoint.id}`)
      .set(bearer(aliceKey));
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe("CONFLICT");

    await request(t.app).post(`/v1/watches/${watch.id}/pause`).set(bearer(aliceKey));
    expect(
      (await request(t.app).delete(`/v1/endpoints/${endpoint.id}`).set(bearer(aliceKey))).status,
    ).toBe(204);
    expect(
      await prisma.delivery.count({ where: { endpointId: endpoint.id, status: "CANCELLED" } }),
    ).toBe(1);
    expect(
      (await request(t.app).get(`/v1/endpoints/${endpoint.id}`).set(bearer(aliceKey))).status,
    ).toBe(404);
    // The paused watch cannot be resumed onto a deleted endpoint.
    expect(
      (await request(t.app).post(`/v1/watches/${watch.id}/resume`).set(bearer(aliceKey))).status,
    ).toBe(409);
  });
});

describe("watches", () => {
  it("creates a watch, storing amounts as stroops and returning both forms", async () => {
    const { endpoint } = await createEndpoint();
    const res = await request(t.app)
      .post("/v1/watches")
      .set(bearer(aliceKey))
      .send({
        walletAddress: randomAddress(),
        label: "Shop checkout",
        endpointId: endpoint.id,
        assets: [USDC, XLM],
        amountRule: { kind: "min", amount: "10.5" },
        memoRule: { kind: "present" },
        senderAllowlist: [],
        eventTypes: ["payment.received", "payment.rejected"],
        backfillHours: 0,
      });
    expect(res.status).toBe(201);
    expect(res.body.watch).toMatchObject({
      label: "Shop checkout",
      amountRule: { kind: "min", amount: "10.5000000", stroops: "105000000" },
      memoRule: { kind: "present" },
      startLedger: 5001, // applies from the ledger after the current one
      active: true,
    });
    const row = await prisma.watch.findUniqueOrThrow({ where: { id: res.body.watch.id } });
    expect(row.amountRule).toEqual({ kind: "min", stroops: "105000000" });

    const got = await request(t.app).get(`/v1/watches/${res.body.watch.id}`).set(bearer(aliceKey));
    expect(got.body.stats).toEqual({ verified24h: 0, rejected24h: 0 });
  });

  it("A1: an invalid address is VALIDATION_FAILED; a pasted secret key is SECRET_KEY_REJECTED and never logged", async () => {
    const { endpoint } = await createEndpoint();
    const post = (walletAddress: string) =>
      request(t.app)
        .post("/v1/watches")
        .set(bearer(aliceKey))
        .send({ walletAddress, endpointId: endpoint.id, assets: [USDC] });

    const invalid = await post("GNOTAREALADDRESS");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatchObject({
      code: "VALIDATION_FAILED",
      details: [{ path: "walletAddress", issue: "invalid_stellar_address" }],
    });

    const secret = Keypair.random().secret();
    const rejected = await post(secret);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe("SECRET_KEY_REJECTED");
    expect(JSON.stringify(rejected.body)).not.toContain(secret);
    const inAllowlist = await request(t.app)
      .post("/v1/watches")
      .set(bearer(aliceKey))
      .send({
        walletAddress: randomAddress(),
        endpointId: endpoint.id,
        assets: [USDC],
        senderAllowlist: [secret],
      });
    expect(inAllowlist.body.error.code).toBe("SECRET_KEY_REJECTED");
    expect(t.logs()).not.toContain(secret);
    expect(await prisma.watch.count({ where: { walletAddress: secret } })).toBe(0);
  });

  it("validates rules strictly: amounts, memo values, issuers and unknown fields", async () => {
    const { endpoint } = await createEndpoint();
    const post = (body: object) =>
      request(t.app)
        .post("/v1/watches")
        .set(bearer(aliceKey))
        .send({ walletAddress: randomAddress(), endpointId: endpoint.id, assets: [USDC], ...body });
    const bad: object[] = [
      { amountRule: { kind: "min", amount: "10.12345678" } },
      { amountRule: { kind: "min", amount: "0" } },
      { amountRule: { kind: "exact", amount: "1e3" } },
      { amountRule: { kind: "range", min: "5", max: "1" } },
      { amountRule: { kind: "min", amount: "1", stroops: "5" } },
      { memoRule: { kind: "equals", value: "x".repeat(29), type: "text" } },
      { memoRule: { kind: "equals", value: "abc", type: "id" } },
      { memoRule: { kind: "equals", value: "zz", type: "hash" } },
      { assets: [{ code: "USDC", issuer: null }] },
      { assets: [] },
      { eventTypes: ["payment.exploded"] },
      { backfillHours: 25 },
      { unknownField: true },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
    expect((await post({ endpointId: "does-not-exist" })).status).toBe(404);
  });

  it("W9: a wallet with no account or no trustline is saved with a warning", async () => {
    const { endpoint } = await createEndpoint();
    const missing = await createWatch(endpoint.id);
    expect(missing.warnings).toEqual(["ACCOUNT_NOT_FOUND"]);

    const wallet = randomAddress();
    t.horizon.accounts.set(wallet, { exists: true, assets: [XLM] });
    const noTrustline = await createWatch(endpoint.id, {
      walletAddress: wallet,
      assets: [USDC, XLM],
    });
    expect(noTrustline.warnings).toEqual(["NO_TRUSTLINE:USDC"]);

    t.horizon.accounts.set(wallet, { exists: true, assets: [XLM, USDC] });
    const ready = await createWatch(endpoint.id, {
      walletAddress: wallet,
      assets: [USDC],
      label: "ready",
    });
    expect(ready.warnings).toEqual([]);

    const unreachable = randomAddress();
    t.horizon.accounts.set(unreachable, null);
    expect((await createWatch(endpoint.id, { walletAddress: unreachable })).warnings).toEqual([
      "HORIZON_UNAVAILABLE",
    ]);
  });

  it("A4: an identical watch created twice is created, with a DUPLICATE_WATCH warning", async () => {
    const { endpoint } = await createEndpoint();
    const body = { walletAddress: randomAddress(), amountRule: { kind: "exact", amount: "5" } };
    const first = await createWatch(endpoint.id, body);
    const second = await createWatch(endpoint.id, body);
    expect(first.warnings).not.toContain("DUPLICATE_WATCH");
    expect(second.warnings).toContain("DUPLICATE_WATCH");
    expect(second.watch.id).not.toBe(first.watch.id);
    const different = await createWatch(endpoint.id, {
      ...body,
      amountRule: { kind: "exact", amount: "6" },
    });
    expect(different.warnings).not.toContain("DUPLICATE_WATCH");
  });

  it("updates rules but never the wallet; pause, resume from the next ledger, soft delete", async () => {
    const { endpoint } = await createEndpoint();
    const { watch } = await createWatch(endpoint.id);
    const patch = (body: object) =>
      request(t.app).patch(`/v1/watches/${watch.id}`).set(bearer(aliceKey)).send(body);

    expect((await patch({ walletAddress: randomAddress() })).status).toBe(400);
    const updated = await patch({ amountRule: { kind: "max", amount: "3" }, label: "renamed" });
    expect(updated.body.watch).toMatchObject({
      label: "renamed",
      amountRule: { kind: "max", stroops: "30000000" },
    });

    const paused = await request(t.app).post(`/v1/watches/${watch.id}/pause`).set(bearer(aliceKey));
    expect(paused.body.watch.active).toBe(false);
    const filtered = await request(t.app).get("/v1/watches?active=false").set(bearer(aliceKey));
    expect(filtered.body.data.every((w: { active: boolean }) => !w.active)).toBe(true);
    expect(filtered.body.data.some((w: { id: string }) => w.id === watch.id)).toBe(true);

    t.horizon.ledger = 6000;
    const resumed = await request(t.app)
      .post(`/v1/watches/${watch.id}/resume`)
      .set(bearer(aliceKey));
    expect(resumed.body.watch).toMatchObject({ active: true, startLedger: 6001 });
    t.horizon.ledger = 5000;

    expect(
      (await request(t.app).delete(`/v1/watches/${watch.id}`).set(bearer(aliceKey))).status,
    ).toBe(204);
    expect((await request(t.app).get(`/v1/watches/${watch.id}`).set(bearer(aliceKey))).status).toBe(
      404,
    );
    const row = await prisma.watch.findUniqueOrThrow({ where: { id: watch.id } });
    expect(row.deletedAt).not.toBeNull(); // history kept
  });
});

describe("payments and events", () => {
  let bob: TestSession;
  let bobKey: string;
  let watchId: string;
  let otherWatchId: string;

  beforeAll(async () => {
    bob = await t.signup();
    bobKey = (await bob.createApiKey()).key;
    const { endpoint } = await createEndpoint(bobKey);
    watchId = (
      await createWatch(
        endpoint.id,
        {
          amountRule: { kind: "min", amount: "5" },
          eventTypes: ["payment.received", "payment.rejected"],
        },
        bobKey,
      )
    ).watch.id;
    otherWatchId = (await createWatch(endpoint.id, {}, bobKey)).watch.id;
    for (let i = 0; i < 5; i++)
      await pay(watchId, {
        amountStroops: 100_000_000n,
        ledgerClosedAt: new Date(`2026-10-0${i + 1}T00:00:00Z`),
      });
    await pay(watchId, {
      amountStroops: 10_000_000n,
      asset: { code: "USDC", issuer: randomAddress() },
      ledgerClosedAt: new Date("2026-10-06T00:00:00Z"),
    });
    await pay(otherWatchId, { memo: "hello", memoType: "text" });
  });

  it("lists payments with their match results, newest first, with stable cursor pagination", async () => {
    const first = await request(t.app).get("/v1/payments?limit=3").set(bearer(bobKey));
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(3);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await request(t.app)
      .get(`/v1/payments?limit=3&cursor=${first.body.nextCursor}`)
      .set(bearer(bobKey));
    const third = await request(t.app)
      .get(`/v1/payments?limit=3&cursor=${second.body.nextCursor}`)
      .set(bearer(bobKey));
    expect(third.body.nextCursor).toBeNull();
    const ids = [...first.body.data, ...second.body.data, ...third.body.data].map(
      (p: { id: string }) => p.id,
    );
    expect(new Set(ids).size).toBe(7);
    expect(first.body.data[0]).toMatchObject({
      memo: "hello",
      amount: "10.0000000",
      amountStroops: "100000000",
      asset: USDC,
    });
    expect(first.body.data[0].matches).toEqual([
      {
        watchId: otherWatchId,
        outcome: "VERIFIED",
        reasons: [],
        eventId: expect.stringMatching(/^evt_/),
      },
    ]);
    expect(
      (await request(t.app).get("/v1/payments?cursor=garbage").set(bearer(bobKey))).status,
    ).toBe(400);
    expect((await request(t.app).get("/v1/payments?limit=500").set(bearer(bobKey))).status).toBe(
      400,
    );
  });

  it("filters payments by watch, wallet, outcome and date range", async () => {
    const get = (query: string) => request(t.app).get(`/v1/payments?${query}`).set(bearer(bobKey));
    expect((await get(`watchId=${watchId}`)).body.data).toHaveLength(6);
    const rejected = await get("outcome=REJECTED");
    expect(rejected.body.data).toHaveLength(1);
    expect(rejected.body.data[0].matches[0].reasons).toEqual(["WRONG_ISSUER", "AMOUNT_BELOW_MIN"]);
    const wallet = (await prisma.watch.findUniqueOrThrow({ where: { id: otherWatchId } }))
      .walletAddress;
    expect((await get(`wallet=${wallet}`)).body.data).toHaveLength(1);
    const ranged = await get(
      `watchId=${watchId}&from=2026-10-02T00:00:00Z&to=2026-10-04T00:00:00Z`,
    );
    expect(ranged.body.data).toHaveLength(3);
  });

  it("returns a payment with rule-by-rule results and linked webhook events", async () => {
    const rejected = (await request(t.app).get("/v1/payments?outcome=REJECTED").set(bearer(bobKey)))
      .body.data[0];
    const res = await request(t.app).get(`/v1/payments/${rejected.id}`).set(bearer(bobKey));
    expect(res.status).toBe(200);
    const match = res.body.payment.matches[0];
    expect(match.checks).toEqual({
      asset: { passed: false, reason: "WRONG_ISSUER" },
      amount: { passed: false, reason: "AMOUNT_BELOW_MIN" },
      memo: { passed: true, reason: null },
      sender: { passed: true, reason: null },
    });
    expect(match.event).toMatchObject({
      type: "payment.rejected",
      deliveries: [{ status: "PENDING", attemptCount: 0 }],
    });
  });

  it("lists and filters events, and returns one with its frozen payload and deliveries", async () => {
    const all = await request(t.app).get("/v1/events").set(bearer(bobKey));
    expect(all.body.data).toHaveLength(7);
    expect(
      (await request(t.app).get("/v1/events?type=payment.rejected").set(bearer(bobKey))).body.data,
    ).toHaveLength(1);
    expect(
      (await request(t.app).get(`/v1/events?watchId=${otherWatchId}`).set(bearer(bobKey))).body
        .data,
    ).toHaveLength(1);
    expect(
      (await request(t.app).get("/v1/events?deliveryStatus=DELIVERED").set(bearer(bobKey))).body
        .data,
    ).toHaveLength(0);
    expect(
      (await request(t.app).get("/v1/events?deliveryStatus=PENDING&limit=2").set(bearer(bobKey)))
        .body.nextCursor,
    ).not.toBeNull();

    const id = all.body.data[0].id;
    const one = await request(t.app).get(`/v1/events/${id}`).set(bearer(bobKey));
    expect(one.body.event).toMatchObject({
      id,
      payload: { id, apiVersion: "2026-10-01" },
      deliveries: [{ status: "PENDING", attempts: [] }],
    });
  });

  it("D12: resend is refused with 409 while the delivery is SENDING, and queues it again afterwards", async () => {
    const event = (await request(t.app).get("/v1/events?limit=1").set(bearer(bobKey))).body.data[0];
    const deliveryId = event.deliveries[0].id;
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "SENDING", leaseUntil: new Date(Date.now() + 60_000), attemptCount: 1 },
    });
    const busy = await request(t.app).post(`/v1/events/${event.id}/resend`).set(bearer(bobKey));
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe("CONFLICT");

    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "DELIVERED", leaseUntil: null, deliveredAt: new Date() },
    });
    const resent = await request(t.app).post(`/v1/events/${event.id}/resend`).set(bearer(bobKey));
    expect(resent.status).toBe(202);
    // Same Delivery row, so the Webhook-Id never changes; attempt numbering continues.
    expect(resent.body.delivery).toMatchObject({
      id: deliveryId,
      status: "PENDING",
      attemptCount: 1,
    });
  });
});

describe("tenant isolation", () => {
  let mallory: TestSession;
  let malloryKey: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    // Victim resources.
    const victim = await t.signup();
    const victimKey = (await victim.createApiKey()).key;
    const { endpoint } = await createEndpoint(victimKey);
    const { watch } = await createWatch(endpoint.id, {}, victimKey);
    const payment = await pay(watch.id);
    const event = await prisma.webhookEvent.findFirstOrThrow({
      where: { developerId: victim.developerId },
    });
    ids.endpoint = endpoint.id;
    ids.watch = watch.id;
    ids.payment = payment.eventId;
    ids.event = event.id;
    ids.apiKey = (await victim.createApiKey()).id;

    mallory = await t.signup();
    malloryKey = (await mallory.createApiKey()).key;
  });

  const routes: [method: "get" | "post" | "patch" | "delete", path: () => string, body?: object][] =
    [
      ["get", () => `/v1/endpoints/${ids.endpoint}`],
      ["patch", () => `/v1/endpoints/${ids.endpoint}`, { description: "pwned" }],
      ["delete", () => `/v1/endpoints/${ids.endpoint}`],
      ["post", () => `/v1/endpoints/${ids.endpoint}/rotate-secret`],
      ["post", () => `/v1/endpoints/${ids.endpoint}/test`],
      ["post", () => `/v1/endpoints/${ids.endpoint}/enable`],
      ["post", () => `/v1/endpoints/${ids.endpoint}/replay`, { since: "2026-01-01T00:00:00Z" }],
      ["get", () => `/v1/watches/${ids.watch}`],
      ["patch", () => `/v1/watches/${ids.watch}`, { label: "pwned" }],
      ["post", () => `/v1/watches/${ids.watch}/pause`],
      ["post", () => `/v1/watches/${ids.watch}/resume`],
      ["delete", () => `/v1/watches/${ids.watch}`],
      ["get", () => `/v1/payments/${ids.payment}`],
      ["get", () => `/v1/events/${ids.event}`],
      ["post", () => `/v1/events/${ids.event}/resend`],
    ];

  it.each(routes)(
    "%s %s on another developer's resource is 404 (API key)",
    async (method, path, body) => {
      const res = await request(t.app)[method](path()).set(bearer(malloryKey)).send(body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    },
  );

  it.each(routes)(
    "%s %s on another developer's resource is 404 (session)",
    async (method, path, body) => {
      const res = await request(t.app)
        [method](path())
        .set("Cookie", mallory.cookie)
        .set("Origin", ORIGIN)
        .send(body);
      expect(res.status).toBe(404);
    },
  );

  it("DELETE /v1/api-keys/:id of another developer's key is 404", async () => {
    const res = await request(t.app)
      .delete(`/v1/api-keys/${ids.apiKey}`)
      .set("Cookie", mallory.cookie)
      .set("Origin", ORIGIN);
    expect(res.status).toBe(404);
    expect(
      (await prisma.apiKey.findUniqueOrThrow({ where: { id: ids.apiKey! } })).revokedAt,
    ).toBeNull();
  });

  it("covers every route that takes an ID", () => {
    const document = generateOpenApiDocument(t.app.locals.registry as OpenAPIRegistry);
    const withIds = Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
      path.includes("{") ? Object.keys(item ?? {}).map((method) => `${method} ${path}`) : [],
    );
    const covered = new Set([
      ...routes.map(
        ([method, path]) =>
          `${method} ${path().replace(ids.endpoint!, "{id}").replace(ids.watch!, "{id}").replace(ids.event!, "{id}").replace(ids.payment!, "{eventId}")}`,
      ),
      "delete /v1/api-keys/{id}",
    ]);
    expect(withIds.filter((route) => !covered.has(route))).toEqual([]);
  });

  it("lists never include another developer's rows, and a watch cannot point at their endpoint", async () => {
    for (const path of ["/v1/endpoints", "/v1/watches", "/v1/payments", "/v1/events"]) {
      const res = await request(t.app).get(path).set(bearer(malloryKey));
      expect(res.body.data, path).toEqual([]);
    }
    expect(
      (await request(t.app).get(`/v1/payments?watchId=${ids.watch}`).set(bearer(malloryKey))).body
        .data,
    ).toEqual([]);
    expect(
      (await request(t.app).get("/v1/api-keys").set("Cookie", mallory.cookie)).body.data,
    ).toHaveLength(1);
    const res = await request(t.app)
      .post("/v1/watches")
      .set(bearer(malloryKey))
      .send({ walletAddress: randomAddress(), endpointId: ids.endpoint, assets: [USDC] });
    expect(res.status).toBe(404);
    // Nothing was changed by any of the attempts above.
    const endpoint = await prisma.endpoint.findUniqueOrThrow({ where: { id: ids.endpoint! } });
    expect(endpoint).toMatchObject({ description: null, deletedAt: null, prevSecretEnc: null });
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: ids.watch! } })).active).toBe(true);
  });
});

describe("OpenAPI", () => {
  it("documents every route the app serves", () => {
    const document = generateOpenApiDocument(t.app.locals.registry as OpenAPIRegistry);
    const documented = new Set(
      Object.entries(document.paths ?? {}).flatMap(([path, item]) =>
        Object.keys(item ?? {}).map((method) => `${method} ${path.replace(/\{(\w+)\}/g, ":$1")}`),
      ),
    );
    const served: string[] = [];
    type Layer = {
      route?: { path: string; methods: Record<string, boolean> };
      handle?: { stack?: Layer[] };
    };
    const walk = (stack: Layer[]) => {
      for (const layer of stack) {
        if (layer.route)
          for (const method of Object.keys(layer.route.methods))
            served.push(`${method} ${layer.route.path}`);
        else if (layer.handle?.stack) walk(layer.handle.stack);
      }
    };
    walk((t.app as unknown as { router: { stack: Layer[] } }).router.stack);

    expect(served.length).toBeGreaterThanOrEqual(30);
    expect(served.filter((route) => !documented.has(route))).toEqual([]);
    expect(document.paths?.["/v1/watches"]?.post?.requestBody).toBeDefined();
    expect(USDC_ISSUER).toHaveLength(56);
  });
});

describe("live stream", () => {
  it("is session-only and delivers each developer only their own events", async () => {
    expect((await request(t.app).get("/v1/stream").set(bearer(aliceKey))).status).toBe(401);

    const server = http.createServer(t.app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    let received = "";
    const req = http.get(
      { host: "127.0.0.1", port, path: "/v1/stream", headers: { cookie: alice.cookie } },
      (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
        res.on("data", (chunk: Buffer) => (received += chunk.toString()));
      },
    );
    try {
      await waitFor(() => received.includes(": connected"));
      const hub = t.app.locals.streamHub as StreamHub;
      hub.publish(CHANNELS.payments, { developerId: "someone-else", paymentId: "secret-payment" });
      hub.publish(CHANNELS.deliveriesUpdated, {
        developerId: alice.developerId,
        deliveryId: "d1",
        status: "DELIVERED",
      });
      await waitFor(() => received.includes("delivery.updated"));
      expect(received).toContain(
        'event: delivery.updated\ndata: {"deliveryId":"d1","status":"DELIVERED"}\n\n',
      );
      expect(received).not.toContain("secret-payment");
    } finally {
      req.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
