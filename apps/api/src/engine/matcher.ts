import type { Prisma } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify.js";
import { buildPaymentPayload } from "../delivery/payload.js";
import { newEventId } from "../lib/ids.js";
import { evaluateWatch } from "./evaluate.js";
import type { NormalizedPayment } from "./types.js";
import type { ParsedWatch } from "./watch.js";

export interface MatchResult {
  /** False when the payment row already existed (primary-key hit or same tx from the other source). */
  inserted: boolean;
  matches: number;
  events: number;
}

const SKIPPED: MatchResult = { inserted: false, matches: 0, events: 0 };

/**
 * The same transaction can reach us from RPC and from the Horizon backfill under different
 * event IDs, possibly at the same moment. Holding this lock for the rest of the database
 * transaction serialises every writer that touches the same Stellar transaction.
 */
export async function lockTransaction(tx: Prisma.TransactionClient, txHash: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${txHash}))::text`;
}

/** Which payment events each endpoint accepts, looked up once per batch instead of per match. */
export type EndpointEvents = Map<string, string[]>;

async function endpointAccepts(
  tx: Prisma.TransactionClient,
  endpointId: string,
  type: string,
  cache: EndpointEvents,
): Promise<boolean> {
  let accepted = cache.get(endpointId);
  if (accepted === undefined) {
    // A watch whose endpoint row is missing is broken data: that throws, so the batch rolls
    // back instead of dropping the event. A deleted endpoint accepts nothing: a delivery to it
    // would never be claimed.
    const endpoint = await tx.endpoint.findUniqueOrThrow({
      where: { id: endpointId },
      select: { eventTypes: true, deletedAt: true },
    });
    accepted = endpoint.deletedAt ? [] : endpoint.eventTypes;
    cache.set(endpointId, accepted);
  }
  return accepted.includes(type);
}

/**
 * Evaluates one watch against a recorded payment and writes the PaymentMatch, plus the
 * WebhookEvent and its first Delivery when the watch asked for that outcome. Returns whether
 * an event was created. The caller guarantees the (payment, watch) pair has no match yet.
 */
export async function createMatch(
  tx: Prisma.TransactionClient,
  p: NormalizedPayment,
  watch: ParsedWatch,
  now: Date,
  endpoints: EndpointEvents = new Map(),
): Promise<boolean> {
  const result = evaluateWatch(p, watch);
  const match = await tx.paymentMatch.create({
    data: {
      paymentEventId: p.eventId,
      watchId: watch.id,
      outcome: result.outcome,
      reasons: result.reasons,
    },
  });

  const type = result.outcome === "VERIFIED" ? "payment.received" : "payment.rejected";
  // Both the watch and its endpoint must want this kind of event.
  const emits =
    watch.eventTypes.includes(type) &&
    (await endpointAccepts(tx, watch.endpointId, type, endpoints));
  if (emits) {
    const eventId = newEventId();
    await tx.webhookEvent.create({
      data: {
        id: eventId,
        developerId: watch.developerId,
        matchId: match.id,
        type,
        payload: buildPaymentPayload({ eventId, type, createdAt: now }, p, watch, result),
        createdAt: now,
        deliveries: { create: { endpointId: watch.endpointId, nextAttemptAt: now } },
      },
    });
  }

  await notify(tx, CHANNELS.payments, {
    developerId: watch.developerId,
    paymentId: p.eventId,
    watchId: watch.id,
    outcome: result.outcome,
  });
  return emits;
}

/**
 * Transaction A. The only place that records payments, with their matches, events and first
 * deliveries. Must be called inside a Prisma transaction; the unique constraints make
 * re-processing a no-op.
 */
export async function processPayment(
  tx: Prisma.TransactionClient,
  p: NormalizedPayment,
  watches: ParsedWatch[],
  now: Date = new Date(),
  endpoints: EndpointEvents = new Map(),
): Promise<MatchResult> {
  // RPC only knows a fee-bump's outer hash and Horizon knows both, so every hash is locked (in
  // a fixed order): two sources handling the same transaction always share at least one lock.
  for (const hash of [p.txHash, ...(p.innerTxHash ? [p.innerTxHash] : [])].sort())
    await lockTransaction(tx, hash);
  const hashes = p.innerTxHash ? [p.txHash, p.innerTxHash] : [p.txHash];
  const fromOtherSource = await tx.chainPayment.findFirst({
    where: {
      source: { not: p.source },
      // Per wallet: one transaction can pay several watched wallets, each seen by a different source.
      toAddress: p.to,
      OR: [{ txHash: { in: hashes } }, { innerTxHash: { in: hashes } }],
    },
    select: { eventId: true },
  });
  if (fromOtherSource) return SKIPPED;

  const eligible = watches.filter(
    (w) => w.walletAddress === p.to && w.active && !w.deletedAt && w.startLedger <= p.ledger,
  );
  // Nothing is watching this wallet at this ledger (e.g. before every watch's startLedger): no row.
  if (eligible.length === 0) return SKIPPED;

  const { count } = await tx.chainPayment.createMany({
    data: [
      {
        eventId: p.eventId,
        txHash: p.txHash,
        innerTxHash: p.innerTxHash ?? null,
        ledger: p.ledger,
        ledgerClosedAt: p.ledgerClosedAt,
        fromAddress: p.from,
        toAddress: p.to,
        toMuxedId: p.toMuxedId ?? null,
        memo: p.memo,
        memoType: p.memoType,
        assetCode: p.asset.code,
        assetIssuer: p.asset.issuer,
        amountStroops: p.amountStroops,
        eventType: p.eventType,
        source: p.source,
      },
    ],
    skipDuplicates: true, // ON CONFLICT (eventId) DO NOTHING
  });
  // The payment may already be recorded (seen before, or by reconciliation) while a watch that
  // should judge it has no match yet: one created just before the payment landed, which the
  // in-memory watch list had not picked up when it was first processed. Only the watches
  // without a match are evaluated, so re-processing stays a no-op.
  let pending = eligible;
  if (count === 0) {
    const matched = await tx.paymentMatch.findMany({
      where: { paymentEventId: p.eventId, watchId: { in: eligible.map((w) => w.id) } },
      select: { watchId: true },
    });
    const done = new Set(matched.map((m) => m.watchId));
    pending = eligible.filter((w) => !done.has(w.id));
    if (pending.length === 0) return SKIPPED;
  }

  let events = 0;
  for (const watch of pending) {
    if (await createMatch(tx, p, watch, now, endpoints)) events += 1;
  }
  if (events > 0) await notify(tx, CHANNELS.deliveries);

  return { inserted: count > 0, matches: pending.length, events };
}
