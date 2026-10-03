import type { Prisma } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify.js";
import { buildPaymentPayload } from "../delivery/payload.js";
import { newEventId } from "../lib/ids.js";
import { evaluateWatch } from "./evaluate.js";
import type { NormalizedPayment } from "./types.js";
import type { ParsedWatch } from "./watch.js";

export interface MatchResult {
  /** False when the payment had already been processed (primary-key hit or same tx from the other source). */
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
  const emits = watch.eventTypes.includes(type);
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
): Promise<MatchResult> {
  await lockTransaction(tx, p.innerTxHash ?? p.txHash);
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
  if (count === 0) return SKIPPED;

  let events = 0;
  for (const watch of eligible) {
    if (await createMatch(tx, p, watch, now)) events += 1;
  }
  if (events > 0) await notify(tx, CHANNELS.deliveries);

  return { inserted: true, matches: eligible.length, events };
}
