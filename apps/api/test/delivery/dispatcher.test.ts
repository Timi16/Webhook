import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  startMockReceiver,
  verifyWebhook,
  type MockReceiver,
} from "../../../../scripts/mock-receiver.js";
import { Dispatcher, type DispatcherDeps } from "../../src/delivery/dispatcher.js";
import { buildPingPayload } from "../../src/delivery/payload.js";
import { createSafeHttpClient, type SafeHttpClient } from "../../src/delivery/safeHttp.js";
import { verifySignature } from "../../src/lib/hmac.js";
import { newEventId } from "../../src/lib/ids.js";
import { createLogger } from "../../src/lib/logger.js";
import type { Mail } from "../../src/lib/mailer.js";
import { createEndpointsRepo } from "../../src/modules/endpoints/repo.js";
import { createEndpointsService } from "../../src/modules/endpoints/service.js";
import { makeTestApp, type TestApp } from "../helpers/app.js";
import { createTestDb, waitFor, type TestDb } from "../helpers/db.js";
import { seedDeveloper, seedEndpoint } from "../helpers/seed.js";
import { testEnv } from "../helpers/testEnv.js";

const env = testEnv();
const logger = createLogger(env);

let db: TestDb;
let prisma: PrismaClient;
let receiver: MockReceiver;
let mails: Mail[];
const clients: SafeHttpClient[] = [];

beforeAll(async () => {
  db = await createTestDb();
  prisma = db.prisma;
  receiver = await startMockReceiver({ slowMs: 250 });
});

afterAll(async () => {
  await receiver.close();
  await db.cleanup();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Developer" CASCADE`;
  receiver.reset();
  mails = [];
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

/** A dispatcher talking to the local mock receiver (which needs the insecure-targets switch). */
function makeDispatcher(
  overrides: Partial<DispatcherDeps> = {},
  httpOptions: Parameters<typeof createSafeHttpClient>[0] = {},
) {
  const http = createSafeHttpClient({ allowInsecure: true, timeoutMs: 2_000, ...httpOptions });
  clients.push(http);
  return new Dispatcher({
    prisma,
    http,
    env,
    logger,
    mailer: { send: async (mail) => void mails.push(mail) },
    random: () => 0.5, // no jitter
    ...overrides,
  });
}

async function setup(path = "/hook", endpointOverrides: Parameters<typeof seedEndpoint>[2] = {}) {
  const developer = await seedDeveloper(prisma);
  const endpoint = await seedEndpoint(prisma, developer.id, {
    url: `${receiver.url}${path}`,
    ...endpointOverrides,
  });
  return { developer, endpoint };
}

async function queue(
  developerId: string,
  endpointId: string,
  data: { attemptCount?: number } = {},
) {
  const eventId = newEventId();
  const createdAt = new Date();
  const event = await prisma.webhookEvent.create({
    data: {
      id: eventId,
      developerId,
      type: "test.ping",
      payload: buildPingPayload({ eventId, type: "test.ping", createdAt }, endpointId),
      // Due a few seconds ago, so a small clock difference between this host and Postgres cannot matter.
      deliveries: {
        create: { endpointId, nextAttemptAt: new Date(createdAt.getTime() - 5_000), ...data },
      },
    },
    include: { deliveries: true },
  });
  return { eventId, deliveryId: event.deliveries[0]!.id };
}

/** Makes everything queued through the API due on the database clock too (see queue()). */
const makeQueuedDue = () =>
  prisma.delivery.updateMany({
    where: { status: "PENDING" },
    data: { nextAttemptAt: new Date(Date.now() - 5_000) },
  });

/** One dispatcher pass, waiting for its sends to be recorded. */
async function pass(dispatcher: Dispatcher): Promise<number> {
  const claimed = await dispatcher.tick();
  await dispatcher.drain();
  return claimed;
}

const makeDue = (deliveryId: string) =>
  prisma.delivery.update({
    where: { id: deliveryId },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });
const delivery = (id: string) =>
  prisma.delivery.findUniqueOrThrow({
    where: { id },
    include: { attempts: { orderBy: { number: "asc" } } },
  });
const endpointRow = (id: string) => prisma.endpoint.findUniqueOrThrow({ where: { id } });

describe("dispatcher", () => {
  it("D1: a 2xx response marks the delivery DELIVERED and keeps the endpoint ACTIVE", async () => {
    const { developer, endpoint } = await setup();
    const { eventId, deliveryId } = await queue(developer.id, endpoint.id);

    expect(await pass(makeDispatcher())).toBe(1);

    const row = await delivery(deliveryId);
    expect(row).toMatchObject({
      status: "DELIVERED",
      attemptCount: 1,
      lastStatusCode: 200,
      lastError: null,
      leaseUntil: null,
    });
    expect(row.deliveredAt).toBeInstanceOf(Date);
    expect(row.attempts).toHaveLength(1);
    expect(row.attempts[0]).toMatchObject({
      number: 1,
      statusCode: 200,
      error: null,
      responseSnippet: '{"received":true}',
    });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "ACTIVE",
      consecutiveFailures: 0,
    });

    expect(receiver.requests).toHaveLength(1);
    const sent = receiver.requests[0]!;
    expect(sent.headers).toMatchObject({
      "content-type": "application/json",
      "user-agent": "Webhook/1.0",
      "webhook-id": eventId,
      "webhook-attempt": "1",
    });
    expect(JSON.parse(sent.body)).toMatchObject({
      id: eventId,
      type: "test.ping",
      apiVersion: "2026-10-01",
    });
    // Verified by the reference verifier and by the docs snippet (the mock receiver's copy).
    expect(
      verifySignature(
        endpoint.secret,
        sent.headers["webhook-signature"]!,
        sent.headers["webhook-timestamp"]!,
        sent.body,
      ),
    ).toBe(true);
    expect(verifyWebhook(endpoint.secret, sent.headers, sent.body)).toBe(true);
    expect(verifyWebhook("whsec_wrong", sent.headers, sent.body)).toBe(false);
  });

  it("D1: a 2xx after failures returns a FAILING endpoint to ACTIVE", async () => {
    const { developer, endpoint } = await setup("/hook", {
      status: "FAILING",
      consecutiveFailures: 3,
    });
    await queue(developer.id, endpoint.id);
    await pass(makeDispatcher());
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "ACTIVE",
      consecutiveFailures: 0,
    });
  });

  it("D2: 4xx/5xx other than 410 goes to RETRYING with the next delay and marks the endpoint FAILING", async () => {
    const { developer, endpoint } = await setup("/hook?mode=500");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();

    const before = Date.now();
    await pass(dispatcher);
    let row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "RETRYING", attemptCount: 1, lastStatusCode: 500 });
    expect(row.nextAttemptAt.getTime() - before).toBeGreaterThanOrEqual(29_900);
    expect(row.nextAttemptAt.getTime() - before).toBeLessThan(32_000);
    expect(row.attempts[0]).toMatchObject({
      statusCode: 500,
      responseSnippet: "mock receiver: internal error",
    });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "FAILING",
      consecutiveFailures: 0,
    });

    // Not due yet: nothing is claimed.
    expect(await pass(dispatcher)).toBe(0);

    await makeDue(deliveryId);
    await pass(dispatcher);
    row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "RETRYING", attemptCount: 2 });
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(115_000); // 2 min after the 2nd failure

    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { url: `${receiver.url}/hook?mode=ok` },
    });
    await makeDue(deliveryId);
    await pass(dispatcher);
    expect(await delivery(deliveryId)).toMatchObject({ status: "DELIVERED", attemptCount: 3 });
  });

  it("D3: no response within the timeout records TIMEOUT and retries", async () => {
    const { developer, endpoint } = await setup("/hook?mode=timeout");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    await pass(makeDispatcher({}, { timeoutMs: 300 }));
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "RETRYING", lastStatusCode: null, lastError: "TIMEOUT" });
    expect(row.attempts[0]).toMatchObject({ statusCode: null, error: "TIMEOUT" });
    expect(row.attempts[0]!.durationMs).toBeGreaterThanOrEqual(280);
  });

  it("D4: a receiver that processed the event but returned 500 gets a retry with the same Webhook-Id", async () => {
    const { developer, endpoint } = await setup("/hook?mode=flaky:1");
    const { eventId, deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();
    await pass(dispatcher);
    await makeDue(deliveryId);
    await pass(dispatcher);

    expect(receiver.requests.map((r) => r.headers["webhook-id"])).toEqual([eventId, eventId]);
    expect(receiver.requests.map((r) => r.headers["webhook-attempt"])).toEqual(["1", "2"]);
    expect(receiver.requests[0]!.body).toBe(receiver.requests[1]!.body); // frozen payload
    expect(await delivery(deliveryId)).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("D5: a 3xx redirect is not followed, is recorded as REDIRECT and retried", async () => {
    const { developer, endpoint } = await setup("/hook?mode=redirect");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    await pass(makeDispatcher());
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "RETRYING", lastStatusCode: 302, lastError: "REDIRECT" });
    expect(receiver.requests.map((r) => r.path)).toEqual(["/hook"]); // /redirected was never requested
  });

  it("D6: 410 Gone fails the delivery, disables the endpoint and emails the developer", async () => {
    const { developer, endpoint } = await setup("/hook?mode=gone");
    const first = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher({ perEndpoint: 1 });
    await pass(dispatcher);
    const second = await queue(developer.id, endpoint.id);

    expect(await delivery(first.deliveryId)).toMatchObject({
      status: "FAILED",
      lastStatusCode: 410,
      attemptCount: 1,
    });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "DISABLED",
      disabledReason: "GONE",
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: developer.email,
      subject: "Your Webhook endpoint was disabled",
    });
    expect(mails[0]!.text).toContain("410 Gone");

    // Nothing more is sent to a disabled endpoint.
    expect(await pass(dispatcher)).toBe(0);
    expect(await delivery(second.deliveryId)).toMatchObject({ status: "PENDING", attemptCount: 0 });
  });

  it("D7: DNS failures, refused connections and bad TLS get their own error codes and are retried", async () => {
    const developer = await seedDeveloper(prisma);
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });

    const dns = await seedEndpoint(prisma, developer.id, {
      url: "http://does-not-exist.invalid/hook",
    });
    const dnsDelivery = await queue(developer.id, dns.id);
    await pass(makeDispatcher({}, { lookup: async () => Promise.reject(notFound) }));
    expect(await delivery(dnsDelivery.deliveryId)).toMatchObject({
      status: "RETRYING",
      lastError: "DNS",
    });

    const closed = await startMockReceiver();
    await closed.close(); // nothing listens on this port any more
    const refused = await seedEndpoint(prisma, developer.id, { url: `${closed.url}/hook` });
    const refusedDelivery = await queue(developer.id, refused.id);
    await pass(makeDispatcher());
    expect(await delivery(refusedDelivery.deliveryId)).toMatchObject({
      status: "RETRYING",
      lastError: "CONN_REFUSED",
    });

    const dir = mkdtempSync(join(tmpdir(), "whk-tls-"));
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "pipe" },
    );
    const selfSigned = await startMockReceiver({
      tls: {
        key: readFileSync(join(dir, "key.pem"), "utf8"),
        cert: readFileSync(join(dir, "cert.pem"), "utf8"),
      },
    });
    try {
      const tls = await seedEndpoint(prisma, developer.id, { url: `${selfSigned.url}/hook` });
      const tlsDelivery = await queue(developer.id, tls.id);
      await pass(makeDispatcher());
      expect(await delivery(tlsDelivery.deliveryId)).toMatchObject({
        status: "RETRYING",
        lastError: "TLS",
      });
      expect(selfSigned.requests).toHaveLength(0);
    } finally {
      await selfSigned.close();
    }
  });

  it("D8: an endpoint that resolves to a blocked IP at send time fails with SSRF_BLOCKED (DNS rebinding)", async () => {
    const developer = await seedDeveloper(prisma);
    // Passed the save-time check with a public address; now the hostname points inside.
    const rebound = await seedEndpoint(prisma, developer.id, {
      url: "https://rebind.example.com/hook",
    });
    const metadata = await seedEndpoint(prisma, developer.id, {
      url: "https://169.254.169.254/latest/meta-data",
    });
    const plainHttp = await seedEndpoint(prisma, developer.id, { url: `${receiver.url}/hook` });
    const a = await queue(developer.id, rebound.id);
    const b = await queue(developer.id, metadata.id);
    const c = await queue(developer.id, plainHttp.id);

    const lookups: string[] = [];
    const strict = makeDispatcher(
      {},
      {
        allowInsecure: false,
        lookup: async (host) => {
          lookups.push(host);
          return [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
          ];
        },
      },
    );
    await pass(strict);

    for (const id of [a.deliveryId, b.deliveryId, c.deliveryId]) {
      const row = await delivery(id);
      expect(row).toMatchObject({
        status: "RETRYING",
        lastError: "SSRF_BLOCKED",
        lastStatusCode: null,
      });
      expect(row.attempts[0]).toMatchObject({ error: "SSRF_BLOCKED" });
    }
    expect(lookups).toEqual(["rebind.example.com"]);
    expect(receiver.requests).toHaveLength(0);
  });

  it("D9: a response body over 64 KB stops being read, keeps 1 KB and still honours the status", async () => {
    const { developer, endpoint } = await setup("/hook?mode=large");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    await pass(makeDispatcher());
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({
      status: "DELIVERED",
      lastStatusCode: 200,
      lastError: "BODY_TOO_LARGE",
    });
    expect(row.attempts[0]!.responseSnippet).toBe("x".repeat(1024));
    expect(row.attempts[0]).toMatchObject({ statusCode: 200, error: "BODY_TOO_LARGE" });
  });

  it("D10: one slow endpoint with 50 due deliveries never has more than 5 in flight; others are unaffected", async () => {
    const developer = await seedDeveloper(prisma);
    const slow = await seedEndpoint(prisma, developer.id, {
      url: `${receiver.url}/slow?mode=slow`,
    });
    const fast = await seedEndpoint(prisma, developer.id, { url: `${receiver.url}/fast` });
    for (let i = 0; i < 50; i++) await queue(developer.id, slow.id);
    const quick = await queue(developer.id, fast.id);

    const dispatcher = makeDispatcher();
    const controller = new AbortController();
    const running = dispatcher.run(controller.signal);
    try {
      await waitFor(async () => (await delivery(quick.deliveryId)).status === "DELIVERED");
      // The fast endpoint was served while the slow one still had a backlog.
      expect(
        await prisma.delivery.count({ where: { endpointId: slow.id, status: "DELIVERED" } }),
      ).toBeLessThan(50);
      await waitFor(
        async () =>
          (await prisma.delivery.count({ where: { endpointId: slow.id, status: "DELIVERED" } })) ===
          50,
        { timeoutMs: 20_000 },
      );
    } finally {
      controller.abort();
      await running;
      await dispatcher.drain();
    }
    expect(receiver.maxConcurrent.get("/slow")).toBe(5);
    expect(receiver.requests.filter((r) => r.path === "/slow")).toHaveLength(50);
  }, 30_000);

  it("D11: a delivery whose worker died mid-send is re-claimed after the lease, with the same Webhook-Id", async () => {
    const { developer, endpoint } = await setup();
    const { eventId, deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();

    // Claimed (SENDING, attempt 1) and then the worker was killed before recording anything.
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "SENDING", attemptCount: 1, leaseUntil: new Date(Date.now() + 60_000) },
    });
    expect(await pass(dispatcher)).toBe(0); // the lease is still live

    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { leaseUntil: new Date(Date.now() - 5_000) },
    });
    expect(await pass(dispatcher)).toBe(1);

    // Nothing was recorded for the crashed send, so this is attempt 1 again, not attempt 2.
    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "DELIVERED", attemptCount: 1 });
    expect(row.attempts.map((a) => a.number)).toEqual([1]);
    expect(receiver.requests[0]!.headers).toMatchObject({
      "webhook-id": eventId,
      "webhook-attempt": "1",
    });
  });

  it("D11: a crash during the 10th attempt still ends as the 10th attempt and counts as a failed event", async () => {
    const { developer, endpoint } = await setup("/hook?mode=500", {
      status: "FAILING",
      consecutiveFailures: 19,
    });
    const { deliveryId } = await queue(developer.id, endpoint.id);
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "SENDING", attemptCount: 10, leaseUntil: new Date(Date.now() - 5_000) },
    });

    await pass(makeDispatcher());

    expect(await delivery(deliveryId)).toMatchObject({ status: "FAILED", attemptCount: 10 });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "DISABLED",
      disabledReason: "TOO_MANY_FAILURES",
      consecutiveFailures: 20,
    });
  });

  it("D10: one developer with many slow endpoints never holds more than 10 of the 20 slots", async () => {
    const greedy = await seedDeveloper(prisma);
    for (let e = 0; e < 4; e++) {
      const slow = await seedEndpoint(prisma, greedy.id, {
        url: `${receiver.url}/tarpit-${e}?mode=slow`,
      });
      for (let i = 0; i < 8; i++) await queue(greedy.id, slow.id);
    }
    const other = await setup("/fast");
    const quick = await queue(other.developer.id, other.endpoint.id);
    const dispatcher = makeDispatcher();

    expect(await dispatcher.tick()).toBe(11); // 10 for the greedy developer + 1 for the other
    const sending = await prisma.delivery.count({
      where: { status: "SENDING", event: { developerId: greedy.id } },
    });
    expect(sending).toBe(10);
    expect(await dispatcher.tick()).toBe(0); // the greedy developer gets no more until a slot frees up
    await waitFor(async () => (await delivery(quick.deliveryId)).status === "DELIVERED");
    await dispatcher.drain();
    expect(
      await prisma.delivery.count({
        where: { status: "DELIVERED", event: { developerId: greedy.id } },
      }),
    ).toBe(10);
  });

  it("D10: a new developer's delivery is served at the first free slot, even when two others fill all 20", async () => {
    for (let g = 0; g < 2; g++) {
      const greedy = await seedDeveloper(prisma);
      for (let e = 0; e < 4; e++) {
        const slow = await seedEndpoint(prisma, greedy.id, {
          url: `${receiver.url}/tarpit-${g}-${e}?mode=slow`,
        });
        for (let i = 0; i < 10; i++) await queue(greedy.id, slow.id);
      }
    }
    const dispatcher = makeDispatcher();
    expect(await dispatcher.tick()).toBe(20); // 10 + 10: every slot is taken, 60 more are queued behind

    const other = await setup("/fast");
    const quick = await queue(other.developer.id, other.endpoint.id);
    const controller = new AbortController();
    const running = dispatcher.run(controller.signal);
    try {
      await waitFor(async () => (await delivery(quick.deliveryId)).status === "DELIVERED");
      // It did not wait for the two backlogs to drain.
      expect(
        await prisma.delivery.count({ where: { status: { in: ["PENDING", "SENDING"] } } }),
      ).toBeGreaterThan(30);
    } finally {
      controller.abort();
      await running;
      await dispatcher.drain();
    }
  }, 30_000);

  it("D13: after a secret rotation both signatures are sent for 24 h, then only the new one", async () => {
    const { developer, endpoint } = await setup("/hook?mode=flaky:1");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();
    await pass(dispatcher); // attempt 1 fails, signed with the original secret only

    const endpoints = createEndpointsService(createEndpointsRepo(prisma), env);
    const { secret: newSecret } = await endpoints.rotateSecret(developer.id, endpoint.id);

    await makeDue(deliveryId);
    await pass(dispatcher);
    const [first, second] = receiver.requests;
    expect(first!.headers["webhook-signature"]!.split(", ")).toHaveLength(1);
    const during = second!.headers["webhook-signature"]!;
    expect(during.split(", ")).toHaveLength(2);
    expect(verifyWebhook(newSecret, second!.headers, second!.body)).toBe(true);
    expect(verifyWebhook(endpoint.secret, second!.headers, second!.body)).toBe(true);

    // A second rotation inside the window keeps the original secret valid as well.
    const { secret: newest } = await endpoints.rotateSecret(developer.id, endpoint.id);
    await queue(developer.id, endpoint.id);
    await pass(dispatcher);
    const twice = receiver.requests[2]!;
    expect(twice.headers["webhook-signature"]!.split(", ")).toHaveLength(3);
    for (const s of [newest, newSecret, endpoint.secret])
      expect(verifyWebhook(s, twice.headers, twice.body)).toBe(true);

    // The grace window is over.
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { prevSecretUntil: new Date(Date.now() - 1_000) },
    });
    await queue(developer.id, endpoint.id);
    await pass(dispatcher);
    const third = receiver.requests[3]!;
    expect(third.headers["webhook-signature"]!.split(", ")).toHaveLength(1);
    expect(verifyWebhook(newest, third.headers, third.body)).toBe(true);
    expect(verifyWebhook(newSecret, third.headers, third.body)).toBe(false);
    expect(verifyWebhook(endpoint.secret, third.headers, third.body)).toBe(false);
  });

  it("D15: when the endpoint URL changes during retries, the next attempt goes to the new URL", async () => {
    const { developer, endpoint } = await setup("/old?mode=500");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();
    await pass(dispatcher);

    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { url: `${receiver.url}/new` },
    });
    await makeDue(deliveryId);
    await pass(dispatcher);

    expect(receiver.requests.map((r) => r.path)).toEqual(["/old", "/new"]);
    expect(await delivery(deliveryId)).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
  });

  it("D16: the 10th failed attempt ends the delivery FAILED; the 20th failed event in a row disables the endpoint", async () => {
    const { developer, endpoint } = await setup("/hook?mode=500", { consecutiveFailures: 18 });
    const dispatcher = makeDispatcher();

    const ninth = await queue(developer.id, endpoint.id, { attemptCount: 8 });
    await pass(dispatcher);
    expect(await delivery(ninth.deliveryId)).toMatchObject({ status: "RETRYING", attemptCount: 9 });
    const wait = (await delivery(ninth.deliveryId)).nextAttemptAt.getTime() - Date.now();
    expect(wait).toBeGreaterThan(23.9 * 3600 * 1000); // 24 h after the 9th failure

    await makeDue(ninth.deliveryId);
    await pass(dispatcher);
    expect(await delivery(ninth.deliveryId)).toMatchObject({
      status: "FAILED",
      attemptCount: 10,
      lastStatusCode: 500,
    });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "FAILING",
      consecutiveFailures: 19,
    });
    expect(mails).toHaveLength(0);

    const twentieth = await queue(developer.id, endpoint.id, { attemptCount: 9 });
    await pass(dispatcher);
    expect(await delivery(twentieth.deliveryId)).toMatchObject({
      status: "FAILED",
      attemptCount: 10,
    });
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "DISABLED",
      disabledReason: "TOO_MANY_FAILURES",
      consecutiveFailures: 20,
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("20 events in a row");
  });

  it("D16: a success in between resets the consecutive failure count", async () => {
    const { developer, endpoint } = await setup("/hook", {
      status: "FAILING",
      consecutiveFailures: 19,
    });
    await queue(developer.id, endpoint.id);
    await pass(makeDispatcher());
    expect(await endpointRow(endpoint.id)).toMatchObject({
      status: "ACTIVE",
      consecutiveFailures: 0,
    });
  });

  it("a delivery cancelled while it was being sent stays CANCELLED, but the attempt is kept", async () => {
    const { developer, endpoint } = await setup("/hook?mode=slow");
    const { deliveryId } = await queue(developer.id, endpoint.id);
    const dispatcher = makeDispatcher();
    await dispatcher.tick();
    await waitFor(() => receiver.requests.length === 1);
    await prisma.delivery.update({
      where: { id: deliveryId },
      data: { status: "CANCELLED", leaseUntil: null },
    });
    await dispatcher.drain();
    const row = await delivery(deliveryId);
    expect(row.status).toBe("CANCELLED");
    expect(row.attempts).toHaveLength(1);
  });
});

describe("delivery controls through the API", () => {
  let t: TestApp;
  let key: string;
  let developerId: string;

  beforeEach(async () => {
    t = makeTestApp(db, { urlPolicy: { allowInsecure: true } });
    const session = await t.signup();
    developerId = session.developerId;
    key = (await session.createApiKey()).key;
  });

  const auth = () => ({ Authorization: `Bearer ${key}` });

  async function createEndpoint(path: string) {
    const res = await request(t.app)
      .post("/v1/endpoints")
      .set(auth())
      .send({ url: `${receiver.url}${path}` });
    expect(res.status).toBe(201);
    return res.body as { endpoint: { id: string }; secret: string };
  }

  it("POST /endpoints/:id/test sends a signed test.ping and returns the first attempt inline", async () => {
    const { endpoint, secret } = await createEndpoint("/hook");
    const dispatcher = makeDispatcher();
    const controller = new AbortController();
    const running = dispatcher.run(controller.signal);
    try {
      const res = await request(t.app).post(`/v1/endpoints/${endpoint.id}/test`).set(auth());
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        eventId: expect.stringMatching(/^evt_/),
        attempt: { statusCode: 200, error: null },
      });
      const sent = receiver.requests[0]!;
      expect(JSON.parse(sent.body)).toMatchObject({ type: "test.ping", id: res.body.eventId });
      expect(verifyWebhook(secret, sent.headers, sent.body)).toBe(true);
    } finally {
      controller.abort();
      await running;
    }
  });

  it("D12: resend while SENDING is 409; after it finishes, resend makes exactly one new attempt", async () => {
    const { endpoint } = await createEndpoint("/hook?mode=slow");
    const { eventId, deliveryId } = await queue(developerId, endpoint.id);
    const dispatcher = makeDispatcher();

    await dispatcher.tick();
    await waitFor(() => receiver.requests.length === 1);
    const during = await request(t.app).post(`/v1/events/${eventId}/resend`).set(auth());
    expect(during.status).toBe(409);
    await dispatcher.drain();
    expect(await delivery(deliveryId)).toMatchObject({ status: "DELIVERED", attemptCount: 1 });

    const after = await request(t.app).post(`/v1/events/${eventId}/resend`).set(auth());
    expect(after.status).toBe(202);
    await makeQueuedDue();
    await pass(dispatcher);
    expect(await pass(dispatcher)).toBe(0);

    const row = await delivery(deliveryId);
    expect(row).toMatchObject({ status: "DELIVERED", attemptCount: 2 });
    expect(row.attempts.map((a) => a.number)).toEqual([1, 2]);
    expect(receiver.requests.map((r) => r.headers["webhook-id"])).toEqual([eventId, eventId]);
  });

  it("D14: re-enabling an endpoint makes it ACTIVE but replays nothing until Replay is used", async () => {
    const { endpoint } = await createEndpoint("/hook");
    const failed = await queue(developerId, endpoint.id, { attemptCount: 10 });
    const old = await queue(developerId, endpoint.id, { attemptCount: 10 });
    await prisma.delivery.updateMany({
      where: { endpointId: endpoint.id },
      data: { status: "FAILED" },
    });
    await prisma.delivery.update({
      where: { id: old.deliveryId },
      data: { createdAt: new Date("2026-01-01T00:00:00Z") },
    });
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { status: "DISABLED", disabledReason: "TOO_MANY_FAILURES", consecutiveFailures: 20 },
    });
    const dispatcher = makeDispatcher();

    const enabled = await request(t.app).post(`/v1/endpoints/${endpoint.id}/enable`).set(auth());
    expect(enabled.body.endpoint).toMatchObject({ status: "ACTIVE", consecutiveFailures: 0 });
    expect(await pass(dispatcher)).toBe(0);
    expect(receiver.requests).toHaveLength(0);

    const replay = await request(t.app)
      .post(`/v1/endpoints/${endpoint.id}/replay`)
      .set(auth())
      .send({ since: "2026-06-01T00:00:00Z" });
    expect(replay.body).toEqual({ requeued: 1 }); // only the one created since that date
    await makeQueuedDue();
    expect(await pass(dispatcher)).toBe(1);
    expect(await delivery(failed.deliveryId)).toMatchObject({
      status: "DELIVERED",
      attemptCount: 11,
    });
    expect(await delivery(old.deliveryId)).toMatchObject({ status: "FAILED" });
    expect(receiver.requests[0]!.headers["webhook-id"]).toBe(failed.eventId);
  });

  it("a resend that fails after the 10th attempt goes straight back to FAILED without counting again", async () => {
    const { endpoint } = await createEndpoint("/hook?mode=500");
    const { eventId, deliveryId } = await queue(developerId, endpoint.id, { attemptCount: 10 });
    await prisma.delivery.update({ where: { id: deliveryId }, data: { status: "FAILED" } });
    await prisma.endpoint.update({
      where: { id: endpoint.id },
      data: { consecutiveFailures: 5, status: "FAILING" },
    });

    expect((await request(t.app).post(`/v1/events/${eventId}/resend`).set(auth())).status).toBe(
      202,
    );
    await makeQueuedDue();
    await pass(makeDispatcher());
    expect(await delivery(deliveryId)).toMatchObject({ status: "FAILED", attemptCount: 11 });
    expect(await endpointRow(endpoint.id)).toMatchObject({ consecutiveFailures: 5 });
  });
});
