import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import type { PrismaClient } from "@prisma/client";
import { Keypair } from "@stellar/stellar-sdk";
import * as R from "@webhook/shared";
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

  it("sets a workspace name at signup or later, and clears it", async () => {
    const res = await request(t.app)
      .post("/auth/signup")
      .set("Origin", ORIGIN)
      .send({ email: `ws-${Date.now()}@example.com`, password: PASSWORD, workspace: "Shopkit" });
    expect(res.body.developer.workspace).toBe("Shopkit");
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    const patch = (body: Record<string, unknown>) =>
      request(t.app).patch("/auth/me").set("Origin", ORIGIN).set("Cookie", cookie).send(body);
    expect((await patch({ workspace: "Shopkit NG" })).body.developer).toMatchObject({
      workspace: "Shopkit NG",
      name: null,
    });
    expect((await patch({ workspace: null })).body.developer.workspace).toBeNull();
    expect((await patch({})).status).toBe(400);
  });

  it("changes the login email only after the link sent to the new address is opened", async () => {
    const dev = await t.signup();
    const other = await t.signup();
    const newEmail = `moved-${Date.now()}@example.com`;
    const ask = (email: string, password = PASSWORD) =>
      request(t.app)
        .post("/auth/email")
        .set("Origin", ORIGIN)
        .set("Cookie", dev.cookie)
        .send({ email, password });

    const wrong = await ask(newEmail, "not the password");
    expect(wrong.body.error.details).toEqual([{ path: "password", issue: "incorrect_password" }]);
    expect((await ask(other.email)).status).toBe(409);
    expect((await ask(dev.email)).body.error.details).toEqual([
      { path: "email", issue: "same_email" },
    ]);

    const before = t.mails.length;
    expect((await ask(newEmail.toUpperCase())).status).toBe(204);
    expect(t.mails).toHaveLength(before + 1);
    expect(t.mails.at(-1)!.to).toBe(newEmail);
    // Nothing changes until the link is opened.
    expect((await request(t.app).get("/auth/me").set("Cookie", dev.cookie)).body.developer.email).toBe(
      dev.email,
    );

    const token = /token=([\w.-]+)/.exec(t.mails.at(-1)!.text)![1]!;
    const confirm = (value: string) =>
      request(t.app).post("/auth/email/confirm").set("Origin", ORIGIN).send({ token: value });
    expect((await confirm(`${token}00`)).status).toBe(400);
    expect((await confirm("garbage")).status).toBe(400);
    const confirmed = await confirm(token);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.developer.email).toBe(newEmail);
    // The link works once: its signature covered the old address.
    expect((await confirm(token)).status).toBe(400);

    const login = (email: string) =>
      request(t.app).post("/auth/login").set("Origin", ORIGIN).send({ email, password: PASSWORD });
    expect((await login(newEmail)).status).toBe(200);
    expect((await login(dev.email)).status).toBe(401);
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

  it("updates the profile name", async () => {
    const dev = await t.signup();
    const res = await request(t.app)
      .patch("/auth/me")
      .set("Cookie", dev.cookie)
      .set("Origin", ORIGIN)
      .send({ name: "  Tolu Adebayo " });
    expect(res.body.developer.name).toBe("Tolu Adebayo");
    expect(
      (
        await request(t.app)
          .patch("/auth/me")
          .set("Cookie", dev.cookie)
          .set("Origin", ORIGIN)
          .send({ name: "" })
      ).status,
    ).toBe(400);
  });

  it("deletes an account with everything it owns, only with the right password", async () => {
    const dev = await t.signup();
    const key = (await dev.createApiKey()).key;
    const { endpoint } = await createEndpoint(key);
    const { watch } = await createWatch(endpoint.id, {}, key);
    const payment = await pay(watch.id);
    const remove = (password: string) =>
      request(t.app)
        .delete("/auth/me")
        .set("Cookie", dev.cookie)
        .set("Origin", ORIGIN)
        .send({ password });

    expect((await remove("not my password")).status).toBe(400);
    expect(await prisma.developer.count({ where: { id: dev.developerId } })).toBe(1);

    expect((await remove(PASSWORD)).status).toBe(204);
    expect(await prisma.developer.count({ where: { id: dev.developerId } })).toBe(0);
    expect(await prisma.watch.count({ where: { id: watch.id } })).toBe(0);
    expect(await prisma.endpoint.count({ where: { id: endpoint.id } })).toBe(0);
    expect(await prisma.chainPayment.count({ where: { eventId: payment.eventId } })).toBe(0);
    expect(await prisma.webhookEvent.count({ where: { developerId: dev.developerId } })).toBe(0);
    expect((await request(t.app).get("/auth/me").set("Cookie", dev.cookie)).status).toBe(401);
    expect((await request(t.app).get("/v1/watches").set(bearer(key))).status).toBe(401);
    // Other developers are untouched.
    expect((await request(t.app).get("/v1/watches").set(bearer(aliceKey))).status).toBe(200);
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

  it("limits a key to its permissions; reading watches and endpoints needs none", async () => {
    const dev = await t.signup();
    const session = (method: "post" | "patch", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const make = async (scopes: string[]) =>
      (await session("post", "/v1/api-keys").send({ name: scopes.join(), scopes })).body as {
        apiKey: { id: string; scopes: string[] };
        key: string;
      };
    const reader = await make(["payments:read"]);
    expect(reader.apiKey.scopes).toEqual(["payments:read"]);
    const call = (key: string, method: "get" | "post" | "delete", path: string) =>
      request(t.app)[method](path).set(bearer(key));

    expect((await call(reader.key, "get", "/v1/payments")).status).toBe(200);
    expect((await call(reader.key, "get", "/v1/events")).status).toBe(200);
    expect((await call(reader.key, "get", "/v1/overview")).status).toBe(200);
    expect((await call(reader.key, "get", "/v1/watches")).status).toBe(200);
    expect((await call(reader.key, "get", "/v1/endpoints")).status).toBe(200);
    const denied = await call(reader.key, "post", "/v1/endpoints").send({
      url: "https://scopes.example.com/hook",
    });
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatchObject({ code: "FORBIDDEN" });
    expect(denied.body.error.message).toContain("endpoints:write");

    const writer = await make(["endpoints:write", "watches:write"]);
    const endpoint = await call(writer.key, "post", "/v1/endpoints").send({
      url: "https://scopes.example.com/hook",
    });
    expect(endpoint.status).toBe(201);
    const watch = await call(writer.key, "post", "/v1/watches").send({
      walletAddress: randomAddress(),
      endpointId: endpoint.body.endpoint.id,
      assets: [USDC],
    });
    expect(watch.status).toBe(201);
    expect((await call(writer.key, "get", "/v1/payments")).status).toBe(403);
    expect((await call(reader.key, "delete", `/v1/watches/${watch.body.watch.id}`)).status).toBe(
      403,
    );

    // A change applies to the key's next request.
    const widened = await session("patch", `/v1/api-keys/${reader.apiKey.id}`).send({
      scopes: ["payments:read", "watches:write"],
    });
    expect(widened.body.apiKey.scopes).toEqual(["payments:read", "watches:write"]);
    expect((await call(reader.key, "delete", `/v1/watches/${watch.body.watch.id}`)).status).toBe(
      204,
    );

    for (const body of [{ scopes: [] }, { scopes: ["admin"] }, {}]) {
      expect((await session("patch", `/v1/api-keys/${reader.apiKey.id}`).send(body)).status).toBe(
        400,
      );
    }
  });

  it("only lets a key in from its allowed IPs", async () => {
    const dev = await t.signup();
    const session = (method: "post" | "patch", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const created = await session("post", "/v1/api-keys").send({
      name: "office only",
      allowedIps: ["203.0.113.0/24", "198.51.100.7"],
    });
    expect(created.status).toBe(201);
    const key = created.body.key as string;
    const from = (ip: string) =>
      request(t.app).get("/v1/watches").set(bearer(key)).set("X-Forwarded-For", ip);

    expect((await from("203.0.113.40")).status).toBe(200);
    expect((await from("198.51.100.7")).status).toBe(200);
    const blocked = await from("198.51.100.8");
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe("FORBIDDEN");
    expect((await request(t.app).get("/v1/watches").set(bearer(key))).status).toBe(403);

    const bad = await session("patch", `/v1/api-keys/${created.body.apiKey.id}`).send({
      allowedIps: ["not-an-ip"],
    });
    expect(bad.status).toBe(400);
    const opened = await session("patch", `/v1/api-keys/${created.body.apiKey.id}`).send({
      allowedIps: [],
    });
    expect(opened.body.apiKey.allowedIps).toEqual([]);
    expect((await from("198.51.100.8")).status).toBe(200);
  });

  it("stops a key at its expiry date and refuses an expiry in the past", async () => {
    const dev = await t.signup();
    const session = (method: "post" | "patch", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const past = await session("post", "/v1/api-keys").send({
      name: "late",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.status).toBe(400);
    expect(past.body.error.details).toEqual([{ path: "expiresAt", issue: "must_be_in_the_future" }]);

    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await session("post", "/v1/api-keys").send({ name: "temporary", expiresAt });
    expect(created.body.apiKey.expiresAt).toBe(expiresAt);
    const key = created.body.key as string;
    const id = created.body.apiKey.id as string;
    expect((await request(t.app).get("/v1/watches").set(bearer(key))).status).toBe(200);

    await prisma.apiKey.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(t.app).get("/v1/watches").set(bearer(key))).status).toBe(401);
    expect((await session("post", `/v1/api-keys/${id}/roll`)).status).toBe(409);

    const cleared = await session("patch", `/v1/api-keys/${id}`).send({ expiresAt: null });
    expect(cleared.body.apiKey.expiresAt).toBeNull();
    expect((await request(t.app).get("/v1/watches").set(bearer(key))).status).toBe(200);
  });

  it("logs each request made with a key, without its query string, and reports usage", async () => {
    const dev = await t.signup();
    const session = (method: "post" | "get", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const created = await session("post", "/v1/api-keys").send({
      name: "logged",
      note: "Order service",
      scopes: ["payments:read"],
    });
    const id = created.body.apiKey.id as string;
    const key = created.body.key as string;
    const secret = Keypair.random().secret();

    await request(t.app).get("/v1/payments?limit=5").set(bearer(key));
    await request(t.app).get(`/v1/payments?q=${secret}`).set(bearer(key));
    await request(t.app).post("/v1/watches").set(bearer(key)).send({}); // 403: no watches:write
    await waitFor(async () => (await prisma.apiKeyRequest.count({ where: { apiKeyId: id } })) === 3);

    const detail = await session("get", `/v1/api-keys/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.apiKey).toMatchObject({ note: "Order service", scopes: ["payments:read"] });
    expect(detail.body.usage).toMatchObject({ requests: 3, errors: 1 });
    expect(detail.body.usage.hourly).toHaveLength(24);
    expect(detail.body.usage.hourly.at(-1)).toMatchObject({ requests: 3, errors: 1 });
    const rows = detail.body.recentRequests as { method: string; path: string; status: number }[];
    expect(rows.map((r) => `${r.method} ${r.path} ${r.status}`).sort()).toEqual([
      "GET /v1/payments 200",
      "GET /v1/payments 200",
      "POST /v1/watches 403",
    ]);
    expect(JSON.stringify(detail.body)).not.toContain(secret);

    // Rolling keeps the settings; deleting removes the log.
    const rolled = await session("post", `/v1/api-keys/${id}/roll`);
    expect(rolled.body.apiKey).toMatchObject({ note: "Order service", scopes: ["payments:read"] });
    await request(t.app)
      .delete(`/v1/api-keys/${id}?permanent=true`)
      .set("Cookie", dev.cookie)
      .set("Origin", ORIGIN);
    expect(await prisma.apiKeyRequest.count({ where: { apiKeyId: id } })).toBe(0);

    const other = await t.signup();
    expect(
      (await request(t.app).get(`/v1/api-keys/${rolled.body.apiKey.id}`).set("Cookie", other.cookie))
        .status,
    ).toBe(404);
  });

  it("renames a key, rolls it with a 24 h overlap, and deletes it for good", async () => {
    const dev = await t.signup();
    const session = (method: "post" | "patch" | "delete" | "get", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const created = await session("post", "/v1/api-keys").send({ name: "worker" });
    const id = created.body.apiKey.id as string;
    const oldKey = created.body.key as string;

    const renamed = await session("patch", `/v1/api-keys/${id}`).send({ name: "payments worker" });
    expect(renamed.body.apiKey).toMatchObject({ id, name: "payments worker" });

    const rolled = await session("post", `/v1/api-keys/${id}/roll`);
    expect(rolled.status).toBe(201);
    expect(rolled.body.apiKey).toMatchObject({ name: "payments worker", revokedAt: null });
    expect(rolled.body.key).not.toBe(oldKey);
    // Both work during the overlap; the old one carries its end date.
    expect((await request(t.app).get("/v1/watches").set(bearer(rolled.body.key))).status).toBe(200);
    expect((await request(t.app).get("/v1/watches").set(bearer(oldKey))).status).toBe(200);
    const old = await prisma.apiKey.findUniqueOrThrow({ where: { id } });
    expect(old.revokedAt!.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600 * 1000);
    await prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date(Date.now() - 1000) } });
    expect((await request(t.app).get("/v1/watches").set(bearer(oldKey))).status).toBe(401);
    expect((await session("post", `/v1/api-keys/${id}/roll`)).status).toBe(409); // already ended

    expect((await session("delete", `/v1/api-keys/${id}?permanent=true`)).status).toBe(204);
    expect(await prisma.apiKey.findUnique({ where: { id } })).toBeNull();
    expect((await session("delete", `/v1/api-keys/${id}?permanent=true`)).status).toBe(404);
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
  it("an endpoint chooses which payment events it accepts, on top of the watch's choice", async () => {
    const created = await request(t.app)
      .post("/v1/endpoints")
      .set(bearer(aliceKey))
      .send({ url: "https://received-only.example.com/hook", eventTypes: ["payment.received"] });
    expect(created.status).toBe(201);
    expect(created.body.endpoint.eventTypes).toEqual(["payment.received"]);
    const { watch } = await createWatch(created.body.endpoint.id, {
      amountRule: { kind: "min", amount: "10" },
      eventTypes: ["payment.received", "payment.rejected"],
    });
    const events = () =>
      prisma.webhookEvent.findMany({ where: { match: { watchId: watch.id } }, select: { type: true } });

    await pay(watch.id, { amountStroops: 10_000_000n }); // 1 USDC: rejected
    expect(await prisma.paymentMatch.count({ where: { watchId: watch.id } })).toBe(1);
    expect(await events()).toEqual([]);

    const patched = await request(t.app)
      .patch(`/v1/endpoints/${created.body.endpoint.id}`)
      .set(bearer(aliceKey))
      .send({ eventTypes: ["payment.received", "payment.rejected"] });
    expect(patched.body.endpoint.eventTypes).toEqual(["payment.received", "payment.rejected"]);
    await pay(watch.id, { amountStroops: 20_000_000n });
    expect(await events()).toEqual([{ type: "payment.rejected" }]);

    const none = await request(t.app)
      .patch(`/v1/endpoints/${created.body.endpoint.id}`)
      .set(bearer(aliceKey))
      .send({ eventTypes: [] });
    expect(none.status).toBe(400);
    // The default is both, so existing behaviour is unchanged.
    expect((await createEndpoint()).endpoint).toMatchObject({
      eventTypes: ["payment.received", "payment.rejected"],
    });
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

  it("backfillHours moves the start ledger back and leaves a durable request for the worker", async () => {
    const { endpoint } = await createEndpoint();
    const { watch } = await createWatch(endpoint.id, { backfillHours: 2 });
    expect(watch.startLedger).toBe(5001 - 2 * 720);
    expect(
      (await prisma.watch.findUniqueOrThrow({ where: { id: watch.id } })).backfillPending,
    ).toBe(true);
    const plain = await createWatch(endpoint.id);
    expect(
      (await prisma.watch.findUniqueOrThrow({ where: { id: plain.watch.id } })).backfillPending,
    ).toBe(false);
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

describe("limits and the current ledger", () => {
  it("caps endpoints, watches and active API keys per developer with 409", async () => {
    const limited = makeTestApp(db, { quotas: { endpoints: 2, watches: 2, apiKeys: 2 } });
    const dev = await limited.signup();
    const first = await dev.createApiKey();
    const key = first.key;
    const post = (path: string, body: object) =>
      request(limited.app).post(path).set(bearer(key)).send(body);

    const endpointIds: string[] = [];
    for (let i = 0; i < 2; i++)
      endpointIds.push(
        (await post("/v1/endpoints", { url: `https://q${i}.example.com` })).body.endpoint.id,
      );
    const third = await post("/v1/endpoints", { url: "https://q3.example.com" });
    expect(third.status).toBe(409);
    expect(third.body.error).toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("limit"),
    });
    // Deleting one frees a place.
    expect(
      (await request(limited.app).delete(`/v1/endpoints/${endpointIds[1]}`).set(bearer(key)))
        .status,
    ).toBe(204);
    expect((await post("/v1/endpoints", { url: "https://q4.example.com" })).status).toBe(201);

    const watch = { walletAddress: randomAddress(), endpointId: endpointIds[0], assets: [USDC] };
    expect((await post("/v1/watches", watch)).status).toBe(201);
    expect((await post("/v1/watches", { ...watch, walletAddress: randomAddress() })).status).toBe(
      201,
    );
    expect((await post("/v1/watches", { ...watch, walletAddress: randomAddress() })).status).toBe(
      409,
    );

    const newKey = () =>
      request(limited.app)
        .post("/v1/api-keys")
        .set("Cookie", dev.cookie)
        .set("Origin", ORIGIN)
        .send({ name: "k" });
    expect((await newKey()).status).toBe(201);
    expect((await newKey()).status).toBe(409);
    await request(limited.app)
      .delete(`/v1/api-keys/${first.id}`)
      .set("Cookie", dev.cookie)
      .set("Origin", ORIGIN);
    expect((await newKey()).status).toBe(201); // revoked keys do not count
  });

  it("estimates the ledger from the worker's cursor when Horizon is down, and refuses when it cannot know", async () => {
    const { endpoint } = await createEndpoint();
    const body = { walletAddress: randomAddress(), endpointId: endpoint.id, assets: [USDC] };
    t.horizon.ledger = null;
    try {
      const blind = await request(t.app).post("/v1/watches").set(bearer(aliceKey)).send(body);
      expect(blind.status).toBe(503);

      // The worker last saved ledger 7000 two minutes ago: about 20 ledgers have closed since.
      await prisma.cursor.create({
        data: {
          name: "rpc-events",
          ledger: 7000,
          networkPassphrase: "Test SDF Network ; September 2015",
          updatedAt: new Date(Date.now() - 120_000),
        },
      });
      const estimated = await request(t.app).post("/v1/watches").set(bearer(aliceKey)).send(body);
      expect(estimated.status).toBe(201);
      expect(estimated.body.watch.startLedger).toBeGreaterThanOrEqual(7020);
      expect(estimated.body.watch.startLedger).toBeLessThanOrEqual(7022);
    } finally {
      t.horizon.ledger = 5000;
      await prisma.cursor.deleteMany();
    }
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
    // Free-text search and the asset filter.
    expect((await get("q=hello")).body.data).toHaveLength(1);
    expect((await get("q=HELL")).body.data).toHaveLength(1);
    expect((await get("q=zzzz-no-such")).body.data).toHaveLength(0);
    expect((await get("asset=USDC")).body.data).toHaveLength(7);
    expect((await get("asset=XLM")).body.data).toHaveLength(0);
    const sample = (await get("limit=1")).body.data[0];
    expect((await get(`q=${sample.from.slice(0, 12)}`)).body.data.length).toBeGreaterThanOrEqual(1);
    expect(
      (await get(`q=${sample.txHash.slice(0, 16)}`)).body.data.map((p: { id: string }) => p.id),
    ).toContain(sample.id);
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
    // Search by the start of an event ID or a payment ID, and filter by endpoint.
    const byEvent = await request(t.app)
      .get(`/v1/events?q=${id.slice(0, 20)}`)
      .set(bearer(bobKey));
    expect(byEvent.body.data.map((e: { id: string }) => e.id)).toContain(id);
    const byPayment = await request(t.app)
      .get(`/v1/events?q=${all.body.data[0].paymentId}`)
      .set(bearer(bobKey));
    expect(byPayment.body.data).toHaveLength(1);
    const endpointId = all.body.data[0].deliveries[0].endpointId;
    expect(
      (await request(t.app).get(`/v1/events?endpointId=${endpointId}`).set(bearer(bobKey))).body
        .data,
    ).toHaveLength(7);
    expect(
      (await request(t.app).get("/v1/events?endpointId=someone-elses").set(bearer(bobKey))).body
        .data,
    ).toHaveLength(0);
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

  it("renaming or rolling another developer's key is 404", async () => {
    const as = (method: "patch" | "post", path: string) =>
      request(t.app)[method](path).set("Cookie", mallory.cookie).set("Origin", ORIGIN);
    expect((await as("patch", `/v1/api-keys/${ids.apiKey}`).send({ name: "pwned" })).status).toBe(
      404,
    );
    expect((await as("post", `/v1/api-keys/${ids.apiKey}/roll`)).status).toBe(404);
    expect(
      (
        await request(t.app)
          .delete(`/v1/api-keys/${ids.apiKey}?permanent=true`)
          .set("Cookie", mallory.cookie)
          .set("Origin", ORIGIN)
      ).status,
    ).toBe(404);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: ids.apiKey! } })).name).toBe(
      "test key",
    );
  });

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
      "get /v1/api-keys/{id}",
      "patch /v1/api-keys/{id}",
      "post /v1/api-keys/{id}/roll",
      // A wallet on the public ledger is not tenant data: any developer may look any address up.
      "get /v1/accounts/{address}",
    ]);
    expect(withIds.filter((route) => !covered.has(route))).toEqual([]);
  });

  it("lists never include another developer's rows, and a watch cannot point at their endpoint", async () => {
    for (const path of ["/v1/endpoints", "/v1/watches", "/v1/payments", "/v1/events"]) {
      const res = await request(t.app).get(path).set(bearer(malloryKey));
      expect(res.body.data, path).toEqual([]);
    }
    const overview = await request(t.app).get("/v1/overview").set(bearer(malloryKey));
    expect(overview.body.payments).toEqual({
      total: 0,
      verified: 0,
      rejected: 0,
      previousTotal: 0,
    });
    expect(overview.body.watches).toEqual({ active: 0, paused: 0 });
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

describe("documented responses", () => {
  it("every response matches the schema published in the API reference", async () => {
    const dev = await t.signup();
    const key = (await dev.createApiKey()).key;
    const session = (method: "get" | "post" | "delete", path: string) =>
      request(t.app)[method](path).set("Cookie", dev.cookie).set("Origin", ORIGIN);
    const api = (method: "get" | "post" | "patch", path: string) =>
      request(t.app)[method](path).set(bearer(key));
    // Schemas are strict: an undocumented field fails just like a missing one.
    const matches = (
      schema: { parse: (value: unknown) => unknown },
      res: { status: number; body: unknown },
      status = 200,
    ) => {
      expect(res.status).toBe(status);
      schema.parse(res.body);
    };

    matches(R.healthResponse, await request(t.app).get("/health"));
    matches(R.developerEnvelope, await session("get", "/auth/me"));
    matches(
      R.apiKeyCreatedResponse,
      await session("post", "/v1/api-keys").send({ name: "second" }),
      201,
    );
    const keys = await session("get", "/v1/api-keys");
    matches(R.apiKeyListResponse, keys);
    matches(R.apiKeyDetailResponse, await session("get", `/v1/api-keys/${keys.body.data[0].id}`));

    const created = await api("post", "/v1/endpoints").send({
      url: "https://docs.example.com/hook",
      description: "d",
    });
    matches(R.endpointCreatedResponse, created, 201);
    const endpointId = created.body.endpoint.id as string;
    matches(R.endpointListResponse, await api("get", "/v1/endpoints"));
    matches(
      R.endpointEnvelope,
      await api("patch", `/v1/endpoints/${endpointId}`).send({ description: null }),
    );
    matches(
      R.rotatedSecretResponse,
      await api("post", `/v1/endpoints/${endpointId}/rotate-secret`),
    );
    matches(R.endpointEnvelope, await api("post", `/v1/endpoints/${endpointId}/enable`));
    matches(
      R.replayResponse,
      await api("post", `/v1/endpoints/${endpointId}/replay`).send({
        since: "2026-01-01T00:00:00Z",
      }),
    );

    const watchBody = {
      walletAddress: randomAddress(),
      endpointId,
      assets: [USDC, XLM],
      eventTypes: ["payment.received", "payment.rejected"],
    };
    const rules = [
      { amountRule: { kind: "any" }, memoRule: { kind: "any" } },
      {
        amountRule: { kind: "min", amount: "5" },
        memoRule: { kind: "equals", value: "7", type: "id" },
      },
      {
        amountRule: { kind: "range", min: "1", max: "9" },
        memoRule: { kind: "absent" },
        label: "ranged",
      },
    ];
    let watchId = "";
    for (const rule of rules) {
      const res = await api("post", "/v1/watches").send({ ...watchBody, ...rule });
      matches(R.watchWithWarningsResponse, res, 201);
      watchId = res.body.watch.id as string;
    }
    const funded = randomAddress();
    t.horizon.accounts.set(funded, { exists: true, assets: [XLM, USDC] });
    const account = await api("get", `/v1/accounts/${funded}`);
    matches(R.accountResponse, account);
    expect(account.body).toEqual({ address: funded, exists: true, assets: [XLM, USDC] });
    expect((await api("get", `/v1/accounts/${randomAddress()}`)).body).toMatchObject({
      exists: false,
      assets: [],
    });
    expect((await api("get", `/v1/accounts/${Keypair.random().secret()}`)).body.error.code).toBe(
      "SECRET_KEY_REJECTED",
    );
    matches(R.watchListResponse, await api("get", "/v1/watches"));
    matches(
      R.watchWithWarningsResponse,
      await api("patch", `/v1/watches/${watchId}`).send({ label: "renamed" }),
    );
    matches(R.watchEnvelope, await api("post", `/v1/watches/${watchId}/pause`));
    matches(R.watchEnvelope, await api("post", `/v1/watches/${watchId}/resume`));

    const verified = await pay(watchId, { amountStroops: 50_000_000n });
    await pay(watchId, {
      amountStroops: 950_000_000n,
      memo: "x",
      memoType: "text",
      toMuxedId: "12",
    });
    matches(R.watchDetailResponse, await api("get", `/v1/watches/${watchId}`));
    const overview = await api("get", "/v1/overview");
    matches(R.overviewResponse, overview);
    expect(overview.body).toMatchObject({
      windowHours: 24,
      payments: { total: 2, verified: 1, rejected: 1, previousTotal: 0 },
      deliveries: { pending: 2, delivered: 0, medianMs: null },
      watches: { active: 3, paused: 0 },
    });
    expect(overview.body.hourly).toHaveLength(24);
    expect(overview.body.hourly.at(-1)).toMatchObject({ verified: 1, rejected: 1 });
    matches(R.paymentListResponse, await api("get", "/v1/payments?limit=1"));
    matches(R.paymentListResponse, await api("get", "/v1/payments"));
    matches(R.paymentDetailResponse, await api("get", `/v1/payments/${verified.eventId}`));

    const events = await api("get", "/v1/events");
    matches(R.eventListResponse, events);
    const eventId = events.body.data[0].id as string;
    const deliveryId = events.body.data[0].deliveries[0].id as string;
    await prisma.deliveryAttempt.create({
      data: {
        deliveryId,
        number: 1,
        startedAt: new Date(),
        durationMs: 12,
        statusCode: 500,
        error: null,
        responseSnippet: "oops",
      },
    });
    matches(R.eventDetailResponse, await api("get", `/v1/events/${eventId}`));
    matches(R.deliveryEnvelope, await api("post", `/v1/events/${eventId}/resend`), 202);
    matches(R.endpointDetailResponse, await api("get", `/v1/endpoints/${endpointId}`));
    // Last, because logging in rotates the session used above.
    matches(
      R.developerEnvelope,
      await session("post", "/auth/login").send({ email: dev.email, password: PASSWORD }),
    );
    // No worker runs here, so the test ping has no attempt yet: the documented null case.
    const fast = makeTestApp(db, { testWaitMs: 50 });
    const fastDev = await fast.signup();
    const fastKey = (await fastDev.createApiKey()).key;
    const fastEndpoint = await request(fast.app)
      .post("/v1/endpoints")
      .set(bearer(fastKey))
      .send({ url: "https://ping.example.com" });
    matches(
      R.testWebhookResponse,
      await request(fast.app)
        .post(`/v1/endpoints/${fastEndpoint.body.endpoint.id}/test`)
        .set(bearer(fastKey)),
    );
  });

  it("the spec carries a response schema for every route that returns a body", () => {
    const document = generateOpenApiDocument(t.app.locals.registry as OpenAPIRegistry);
    const missing: string[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {})) {
      for (const [method, operation] of Object.entries(item ?? {})) {
        const responses =
          (operation as { responses?: Record<string, { content?: unknown }> }).responses ?? {};
        const success = Object.entries(responses).find(([status]) => status.startsWith("2"));
        if (success && success[0] !== "204" && !success[1].content)
          missing.push(`${method} ${path}`);
      }
    }
    expect(missing).toEqual(["get /v1/stream"]); // Server-Sent Events, not JSON
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
