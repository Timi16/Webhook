import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgListener, CHANNELS } from "../../src/db/notify.js";
import { loadCursor, saveCursor } from "../../src/engine/cursor.js";
import { Ingestion } from "../../src/engine/ingestion.js";
import { processPayment } from "../../src/engine/matcher.js";
import { handleNetworkReset } from "../../src/engine/networkReset.js";
import { reconcile } from "../../src/engine/reconciliation.js";
import { WatchedSet } from "../../src/engine/watchedSet.js";
import { createLogger } from "../../src/lib/logger.js";
import { createTestDb, waitFor, type TestDb } from "../helpers/db.js";
import { fakeBackfill, FakeSource } from "../helpers/fakeSource.js";
import { makePayment, randomAddress, USDC, XLM } from "../helpers/payments.js";
import { seedDeveloper, seedEndpoint, seedTenant, seedWatch } from "../helpers/seed.js";
import { testEnv } from "../helpers/testEnv.js";

const env = testEnv();
const logger = createLogger(env);

let db: TestDb;
let prisma: PrismaClient;
let source: FakeSource;
let watchedSet: WatchedSet;
let ingestion: Ingestion;
const alert = vi.fn(async (_message: string) => {});

beforeAll(async () => {
  db = await createTestDb();
  prisma = db.prisma;
});

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "Developer", "ChainPayment", "Cursor" CASCADE`;
  alert.mockClear();
  source = new FakeSource();
  watchedSet = new WatchedSet(prisma, logger);
  ingestion = new Ingestion({
    prisma,
    source,
    backfill: fakeBackfill(),
    watchedSet,
    networkPassphrase: env.NETWORK_PASSPHRASE,
    logger,
    onNetworkReset: (tip) =>
      handleNetworkReset({ prisma, networkPassphrase: env.NETWORK_PASSPHRASE, alert, logger }, tip),
  });
  await saveCursor(prisma, { ledger: 900 }, env.NETWORK_PASSPHRASE);
});

/** Runs the loop until the source has nothing more to give. */
async function drain(): Promise<void> {
  while ((await ingestion.tick()) === 0) {
    // keep going while full pages come back
  }
}

describe("ingestion and matching", () => {
  it("starts at the tip on first boot, not genesis", async () => {
    await prisma.cursor.deleteMany();
    source.tip = 4321;
    await ingestion.tick();
    expect(await loadCursor(prisma)).toMatchObject({ ledger: 4321 });
  });

  it("W1: a payment that passes every rule creates a VERIFIED match, an event and a due delivery", async () => {
    const { watch, endpoint, developer } = await seedTenant(prisma);
    await watchedSet.reload();
    const payment = makePayment({
      to: watch.walletAddress,
      ledger: 950,
      memo: "inv-1",
      memoType: "text",
    });
    source.payments.push(payment);

    await ingestion.tick();

    const row = await prisma.chainPayment.findUniqueOrThrow({
      where: { eventId: payment.eventId },
    });
    expect(row).toMatchObject({
      toAddress: watch.walletAddress,
      amountStroops: 100_000_000n,
      memo: "inv-1",
      source: "rpc",
    });
    const match = await prisma.paymentMatch.findFirstOrThrow({
      where: { paymentEventId: payment.eventId },
    });
    expect(match).toMatchObject({ watchId: watch.id, outcome: "VERIFIED", reasons: [] });
    const event = await prisma.webhookEvent.findFirstOrThrow({
      where: { matchId: match.id },
      include: { deliveries: true },
    });
    expect(event.id).toMatch(/^evt_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(event).toMatchObject({ type: "payment.received", developerId: developer.id });
    expect(event.payload).toMatchObject({
      id: event.id,
      type: "payment.received",
      apiVersion: "2026-10-01",
      data: {
        payment: {
          id: payment.eventId,
          amount: "10.0000000",
          amountStroops: "100000000",
          memo: "inv-1",
        },
        watch: { id: watch.id },
        verification: { outcome: "VERIFIED", reasons: [] },
      },
    });
    expect(event.deliveries).toHaveLength(1);
    expect(event.deliveries[0]).toMatchObject({
      endpointId: endpoint.id,
      status: "PENDING",
      attemptCount: 0,
    });
    expect(await loadCursor(prisma)).toMatchObject({ ledger: 1000 });
  });

  it("W2: a failing payment is REJECTED with every reason; payment.rejected only if opted in", async () => {
    const quiet = await seedTenant(prisma, {
      amountRule: { kind: "min", stroops: "500000000" },
      memoRule: { kind: "present" },
    });
    const optedIn = await seedTenant(prisma, {
      amountRule: { kind: "min", stroops: "500000000" },
      eventTypes: ["payment.received", "payment.rejected"],
    });
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: quiet.watch.walletAddress, ledger: 950 }),
      makePayment({ to: optedIn.watch.walletAddress, ledger: 950 }),
    );

    await ingestion.tick();

    const quietMatch = await prisma.paymentMatch.findFirstOrThrow({
      where: { watchId: quiet.watch.id },
      include: { event: true },
    });
    expect(quietMatch.outcome).toBe("REJECTED");
    expect(quietMatch.reasons).toEqual(["AMOUNT_BELOW_MIN", "MEMO_MISSING"]);
    expect(quietMatch.event).toBeNull();

    const optedMatch = await prisma.paymentMatch.findFirstOrThrow({
      where: { watchId: optedIn.watch.id },
      include: { event: true },
    });
    expect(optedMatch.reasons).toEqual(["AMOUNT_BELOW_MIN"]);
    expect(optedMatch.event).toMatchObject({ type: "payment.rejected" });
  });

  it("W3: USDC from a different issuer is recorded and rejected as WRONG_ISSUER", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    source.payments.push(
      makePayment({
        to: watch.walletAddress,
        ledger: 950,
        asset: { code: "USDC", issuer: randomAddress() },
      }),
    );
    await ingestion.tick();
    const match = await prisma.paymentMatch.findFirstOrThrow({ where: { watchId: watch.id } });
    expect(match).toMatchObject({ outcome: "REJECTED", reasons: ["WRONG_ISSUER"] });
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("W4: two watches on one wallet both match - two matches, two events", async () => {
    const wallet = randomAddress();
    const a = await seedTenant(prisma, { walletAddress: wallet });
    const b = await seedTenant(prisma, { walletAddress: wallet });
    await watchedSet.reload();
    source.payments.push(makePayment({ to: wallet, ledger: 950 }));

    await ingestion.tick();

    expect(await prisma.chainPayment.count()).toBe(1);
    expect(await prisma.paymentMatch.count()).toBe(2);
    const events = await prisma.webhookEvent.findMany();
    expect(events.map((e) => e.developerId).sort()).toEqual(
      [a.developer.id, b.developer.id].sort(),
    );
    expect(await prisma.delivery.count()).toBe(2);
  });

  it("W5: the same event from the live loop and reconciliation gives one payment, one match, one event", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    source.payments.push(makePayment({ to: watch.walletAddress, ledger: 950 }));

    await ingestion.tick();
    const before = await loadCursor(prisma);
    const first = await reconcile({ prisma, source, watchedSet, logger });
    const second = await reconcile({ prisma, source, watchedSet, logger });

    expect(first).toEqual({ scanned: 1, recovered: 0 });
    expect(second).toEqual({ scanned: 1, recovered: 0 });
    expect(await prisma.chainPayment.count()).toBe(1);
    expect(await prisma.paymentMatch.count()).toBe(1);
    expect(await prisma.webhookEvent.count()).toBe(1);
    expect(await prisma.delivery.count()).toBe(1);
    expect(await loadCursor(prisma)).toEqual(before); // reconciliation never moves the cursor
  });

  it("reconciliation recovers a payment the live loop skipped", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    await saveCursor(prisma, { ledger: 1000, pagingToken: "1" }, env.NETWORK_PASSPHRASE);
    source.payments.push(makePayment({ to: watch.walletAddress, ledger: 990 }));

    expect(await reconcile({ prisma, source, watchedSet, logger })).toEqual({
      scanned: 1,
      recovered: 1,
    });
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("W6: a payment in a ledger before the watch's startLedger is ignored", async () => {
    const { watch } = await seedTenant(prisma, { startLedger: 960 });
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: watch.walletAddress, ledger: 959 }),
      makePayment({ to: watch.walletAddress, ledger: 960 }),
    );
    await ingestion.tick();
    const matches = await prisma.paymentMatch.findMany({ include: { payment: true } });
    expect(matches.map((m) => m.payment.ledger)).toEqual([960]);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("W7: paused or deleted watches ignore new payments while existing deliveries continue", async () => {
    const paused = await seedTenant(prisma);
    const deleted = await seedTenant(prisma);
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: paused.watch.walletAddress, ledger: 950 }),
      makePayment({ to: deleted.watch.walletAddress, ledger: 950 }),
    );
    await ingestion.tick();
    expect(await prisma.delivery.count({ where: { status: "PENDING" } })).toBe(2);

    await prisma.watch.update({ where: { id: paused.watch.id }, data: { active: false } });
    await prisma.watch.update({
      where: { id: deleted.watch.id },
      data: { active: false, deletedAt: new Date() },
    });
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: paused.watch.walletAddress, ledger: 951 }),
      makePayment({ to: deleted.watch.walletAddress, ledger: 951 }),
    );
    await ingestion.tick();

    expect(await prisma.chainPayment.count()).toBe(2);
    expect(await prisma.paymentMatch.count()).toBe(2);
    // The deliveries created before the pause are untouched and still due.
    expect(await prisma.delivery.count({ where: { status: "PENDING" } })).toBe(2);
  });

  it("W7: a stale in-memory watch that was paused in the database is still skipped by the matcher", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    const stale = watchedSet.get(watch.walletAddress).map((w) => ({ ...w, active: false }));
    await prisma.$transaction((tx) =>
      processPayment(tx, makePayment({ to: watch.walletAddress }), stale),
    );
    expect(await prisma.paymentMatch.count()).toBe(0);
  });

  it("W8: editing rules after an event exists leaves the old payload unchanged; new rules apply next", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: watch.walletAddress, ledger: 950, amountStroops: 10_000_000n }),
    );
    await ingestion.tick();
    const before = await prisma.webhookEvent.findFirstOrThrow();

    await prisma.watch.update({
      where: { id: watch.id },
      data: { amountRule: { kind: "min", stroops: "50000000" }, label: "renamed" },
    });
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: watch.walletAddress, ledger: 951, amountStroops: 10_000_000n }),
    );
    await ingestion.tick();
    await reconcile({ prisma, source, watchedSet, logger });

    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.payload).toEqual(before.payload);
    const matches = await prisma.paymentMatch.findMany({ orderBy: { createdAt: "asc" } });
    expect(matches.map((m) => m.outcome)).toEqual(["VERIFIED", "REJECTED"]);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("W10: path payments, contract-wallet payers, muxed destinations and mints all match the base wallet", async () => {
    const { watch } = await seedTenant(prisma, { assets: [USDC, XLM] });
    await watchedSet.reload();
    source.payments.push(
      makePayment({ to: watch.walletAddress, ledger: 950, asset: XLM }), // path payment arrives as a transfer
      makePayment({
        to: watch.walletAddress,
        ledger: 950,
        from: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
      }),
      makePayment({ to: watch.walletAddress, ledger: 951, memo: "42", memoType: "id" }), // paid to an M-address
      makePayment({ to: watch.walletAddress, ledger: 951, eventType: "mint", from: USDC.issuer }),
    );
    await ingestion.tick();
    expect(
      await prisma.paymentMatch.count({ where: { watchId: watch.id, outcome: "VERIFIED" } }),
    ).toBe(4);
    expect(await prisma.webhookEvent.count()).toBe(4);
  });

  it("W14: a busy wallet over 600 events a minute queues everything, drops nothing and raises a notice", async () => {
    const { watch, developer } = await seedTenant(prisma);
    await watchedSet.reload();
    const listener = new PgListener(db.url, logger);
    const notices: Record<string, unknown>[] = [];
    listener.on(CHANNELS.notices, (payload) => notices.push(payload));
    await listener.start();
    try {
      for (let i = 0; i < 700; i++) {
        source.payments.push(
          makePayment({ to: watch.walletAddress, ledger: 901 + Math.floor(i / 10) }),
        );
      }
      await drain();

      expect(await prisma.chainPayment.count()).toBe(700);
      expect(await prisma.paymentMatch.count()).toBe(700);
      expect(await prisma.delivery.count({ where: { status: "PENDING" } })).toBe(700);
      await waitFor(() => notices.length > 0);
      expect(notices).toEqual([
        { developerId: developer.id, kind: "BUSY_WALLET", wallet: watch.walletAddress },
      ]);
    } finally {
      await listener.stop();
    }
  }, 60_000);

  it("W15: a testnet reset moves the cursor, notifies every active endpoint and alerts", async () => {
    const a = await seedTenant(prisma);
    const b = await seedTenant(prisma);
    const disabled = await seedEndpoint(prisma, a.developer.id, { status: "DISABLED" });
    await prisma.watch.update({ where: { id: a.watch.id }, data: { startLedger: 499_000 } });
    await saveCursor(prisma, { ledger: 500_000, pagingToken: "old-token" }, env.NETWORK_PASSPHRASE);
    source.tip = 120; // the tip ledger dropped

    expect(await ingestion.tick()).toBe(0);

    const cursor = await prisma.cursor.findUniqueOrThrow({ where: { name: "rpc-events" } });
    expect(cursor).toMatchObject({ ledger: 120, pagingToken: null });
    expect(cursor.lastNetworkResetAt).toBeInstanceOf(Date);
    const events = await prisma.webhookEvent.findMany({ include: { deliveries: true } });
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "system.network_reset" && e.matchId === null)).toBe(true);
    expect(events.flatMap((e) => e.deliveries.map((d) => d.endpointId)).sort()).toEqual(
      [a.endpoint.id, b.endpoint.id].sort(),
    );
    expect(events.flatMap((e) => e.deliveries.map((d) => d.endpointId))).not.toContain(disabled.id);
    expect(alert).toHaveBeenCalledOnce();

    // Watches keep working on the new chain: a start ledger from the old network is pulled back.
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: a.watch.id } })).startLedger).toBe(
      120,
    );
    expect((await prisma.watch.findUniqueOrThrow({ where: { id: b.watch.id } })).startLedger).toBe(
      1,
    );
    await prisma.webhookEvent.deleteMany();
    await watchedSet.reload();
    source.payments.push(makePayment({ to: a.watch.walletAddress, ledger: 125 }));
    source.tip = 130;
    await ingestion.tick();
    expect(await prisma.webhookEvent.count({ where: { type: "payment.received" } })).toBe(1);
    source.tip = 120;
    await saveCursor(prisma, { ledger: 120 }, env.NETWORK_PASSPHRASE);

    // A small dip (RPC node slightly behind) is not a reset.
    alert.mockClear();
    source.tip = 60;
    await ingestion.tick();
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("crash safety", () => {
  it("a failure anywhere in the batch commits nothing, and the retry processes it exactly once", async () => {
    const good = await seedTenant(prisma);
    const developer = await seedDeveloper(prisma);
    const endpoint = await seedEndpoint(prisma, developer.id);
    const doomed = await seedWatch(prisma, developer.id, endpoint.id);
    await watchedSet.reload();
    // The in-memory watch now points at an endpoint that no longer exists, so its delivery insert fails.
    watchedSet.get(doomed.walletAddress)[0]!.endpointId = "missing-endpoint";
    source.payments.push(
      makePayment({ to: good.watch.walletAddress, ledger: 950 }),
      makePayment({ to: doomed.walletAddress, ledger: 951 }),
    );

    await expect(ingestion.tick()).rejects.toThrow();
    expect(await prisma.chainPayment.count()).toBe(0);
    expect(await prisma.webhookEvent.count()).toBe(0);
    expect(await loadCursor(prisma)).toEqual({ ledger: 900 }); // never saved on error

    await watchedSet.reload();
    await ingestion.tick();
    await ingestion.tick();
    expect(await prisma.chainPayment.count()).toBe(2);
    expect(await prisma.paymentMatch.count()).toBe(2);
    expect(await prisma.webhookEvent.count()).toBe(2);
  });

  it("an RPC failure leaves the cursor where it was", async () => {
    source.failNextFetch = true;
    await expect(ingestion.tick()).rejects.toThrow("RPC unreachable");
    expect(await loadCursor(prisma)).toEqual({ ledger: 900 });
  });

  it("replaying the whole stream after a restart creates nothing new", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    for (let i = 0; i < 20; i++)
      source.payments.push(makePayment({ to: watch.walletAddress, ledger: 910 + i }));
    await drain();
    expect(await prisma.chainPayment.count()).toBe(20);

    // Simulate kill -9 before the cursor was durable: rewind and run again.
    await saveCursor(prisma, { ledger: 900 }, env.NETWORK_PASSPHRASE);
    await drain();
    expect(await prisma.chainPayment.count()).toBe(20);
    expect(await prisma.paymentMatch.count()).toBe(20);
    expect(await prisma.webhookEvent.count()).toBe(20);
    expect(await prisma.delivery.count()).toBe(20);
  });
});

describe("Horizon backfill", () => {
  const horizonRecord = (
    wallet: string,
    ledger: number,
    op: number,
    extra: Record<string, unknown> = {},
  ) => {
    const id = ((BigInt(ledger) << 32n) | BigInt(4096 + op)).toString();
    return {
      id,
      paging_token: id,
      type: "payment",
      transaction_successful: true,
      transaction_hash: `${ledger.toString(16).padStart(8, "0")}${op}`.padEnd(64, "0"),
      created_at: "2026-10-03T18:52:22Z",
      from: randomAddress(),
      to: wallet,
      amount: "2.5000000",
      asset_type: "credit_alphanum4",
      asset_code: USDC.code,
      asset_issuer: USDC.issuer,
      transaction: { ledger, memo_type: "text", memo: "from-horizon" },
      ...extra,
    };
  };

  it("fills the gap from Horizon when the cursor is older than RPC retention, then resumes at the RPC start", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    await saveCursor(prisma, { ledger: 100, pagingToken: "expired" }, env.NETWORK_PASSPHRASE);
    source.oldest = 500;
    const wallet = watch.walletAddress;
    const gapIngestion = new Ingestion({
      prisma,
      source,
      backfill: fakeBackfill({
        [wallet]: [
          horizonRecord(wallet, 90, 1), // before the gap
          horizonRecord(wallet, 150, 1),
          horizonRecord(wallet, 300, 1, { to_muxed_id: "77" }),
          horizonRecord(wallet, 300, 2, { transaction_successful: false }),
          horizonRecord(wallet, 600, 1), // RPC covers this ledger
        ],
      }),
      watchedSet,
      networkPassphrase: env.NETWORK_PASSPHRASE,
      logger,
      onNetworkReset: async () => {},
    });

    expect(await gapIngestion.tick()).toBe(0);

    const rows = await prisma.chainPayment.findMany({ orderBy: { ledger: "asc" } });
    expect(rows.map((r) => r.ledger)).toEqual([150, 300]);
    expect(rows[0]).toMatchObject({
      source: "horizon",
      memo: "from-horizon",
      memoType: "text",
      amountStroops: 25_000_000n,
    });
    expect(rows[0]!.eventId).toMatch(/^hz-\d+$/);
    expect(rows[1]).toMatchObject({ memo: "77", memoType: "id", toMuxedId: "77" });
    expect(await prisma.webhookEvent.count()).toBe(2);
    expect(await loadCursor(prisma)).toEqual({ ledger: 500 });
  });

  it("never double-counts a transaction seen by both Horizon and RPC", async () => {
    const { watch } = await seedTenant(prisma);
    await watchedSet.reload();
    const watches = watchedSet.get(watch.walletAddress);
    const viaHorizon = makePayment({
      to: watch.walletAddress,
      source: "horizon",
      eventId: "hz-123",
    });
    const viaRpc = {
      ...viaHorizon,
      source: "rpc" as const,
      eventId: "0000000000000000123-0000000000",
    };

    const first = await prisma.$transaction((tx) => processPayment(tx, viaHorizon, watches));
    const second = await prisma.$transaction((tx) => processPayment(tx, viaRpc, watches));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(await prisma.chainPayment.count()).toBe(1);
    expect(await prisma.webhookEvent.count()).toBe(1);
  });

  it("still records another wallet's payment from the same transaction when it arrives from the other source", async () => {
    const first = await seedTenant(prisma);
    const second = await seedTenant(prisma);
    await watchedSet.reload();
    const txHash = "ab".repeat(32);
    const toFirst = makePayment({ to: first.watch.walletAddress, txHash, source: "rpc" });
    const toSecond = makePayment({
      to: second.watch.walletAddress,
      txHash,
      source: "horizon",
      eventId: "hz-999",
    });

    await prisma.$transaction((tx) => processPayment(tx, toFirst, watchedSet.get(toFirst.to)));
    const result = await prisma.$transaction((tx) =>
      processPayment(tx, toSecond, watchedSet.get(toSecond.to)),
    );

    expect(result.inserted).toBe(true);
    expect(await prisma.webhookEvent.count()).toBe(2);
  });
});
