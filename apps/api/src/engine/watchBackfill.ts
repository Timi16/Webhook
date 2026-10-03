import type { ChainPayment, PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify.js";
import type { Logger } from "../lib/logger.js";
import { loadCursor, loadNetworkGeneration } from "./cursor.js";
import { createMatch, lockTransaction } from "./matcher.js";
import type { MemoType, NormalizedPayment } from "./types.js";
import { parseWatch, type ParsedWatch } from "./watch.js";
import type { WatchedSet } from "./watchedSet.js";

export interface WatchBackfillDeps {
  prisma: PrismaClient;
  watchedSet: WatchedSet;
  logger: Logger;
  /** Records payments Horizon knows about for ledgers in [fromLedger, toLedgerExclusive). */
  backfillWallet: (wallet: string, fromLedger: number, toLedgerExclusive: number) => Promise<void>;
}

function fromRow(row: ChainPayment): NormalizedPayment {
  return {
    eventId: row.eventId,
    txHash: row.txHash,
    ...(row.innerTxHash ? { innerTxHash: row.innerTxHash } : {}),
    ledger: row.ledger,
    ledgerClosedAt: row.ledgerClosedAt,
    from: row.fromAddress,
    to: row.toAddress,
    ...(row.toMuxedId ? { toMuxedId: row.toMuxedId } : {}),
    memo: row.memo,
    memoType: row.memoType as MemoType,
    asset: { code: row.assetCode, issuer: row.assetIssuer },
    amountStroops: row.amountStroops,
    eventType: row.eventType === "mint" ? "mint" : "transfer",
    source: row.source === "horizon" ? "horizon" : "rpc",
  };
}

/** Rows recorded on an earlier testnet (before the last reset) never belong to a backfill. */
function isCurrentNetwork(eventId: string, generation: string | null): boolean {
  return generation ? eventId.startsWith(`r${generation}-`) : !/^r[0-9a-z]+-/.test(eventId);
}

/**
 * Payments already recorded for this wallet (because another watch saw them) get a match for
 * the backfilled watch too. Returns how many matches were added.
 */
export async function matchRecordedPayments(
  prisma: PrismaClient,
  watch: ParsedWatch,
  upToLedger: number,
  now: Date = new Date(),
): Promise<number> {
  const generation = await loadNetworkGeneration(prisma);
  const rows = await prisma.chainPayment.findMany({
    where: {
      toAddress: watch.walletAddress,
      ledger: { gte: watch.startLedger, lte: upToLedger },
      matches: { none: { watchId: watch.id } },
    },
    orderBy: [{ ledger: "asc" }, { eventId: "asc" }],
  });

  let added = 0;
  for (const row of rows) {
    if (!isCurrentNetwork(row.eventId, generation)) continue;
    await prisma.$transaction(async (tx) => {
      await lockTransaction(tx, row.innerTxHash ?? row.txHash);
      // The live loop may have matched it since we looked.
      const existing = await tx.paymentMatch.findUnique({
        where: { paymentEventId_watchId: { paymentEventId: row.eventId, watchId: watch.id } },
      });
      if (existing) return;
      if (await createMatch(tx, fromRow(row), watch, now)) await notify(tx, CHANNELS.deliveries);
      added += 1;
    });
  }
  return added;
}

/**
 * Runs every backfill that is still owed. The request is the `backfillPending` flag on the
 * watch, so it survives a worker restart and is only cleared once the backfill has finished.
 */
export async function runPendingBackfills(deps: WatchBackfillDeps): Promise<number> {
  const { prisma, watchedSet, logger } = deps;
  const pending = await prisma.watch.findMany({
    where: { backfillPending: true },
    orderBy: { createdAt: "asc" },
  });
  if (pending.length === 0) return 0;

  const cursor = await loadCursor(prisma);
  if (!cursor) return 0; // the live loop has not started yet; try again on the next round
  await watchedSet.reload();

  let done = 0;
  for (const row of pending) {
    try {
      if (row.active && !row.deletedAt) {
        const watch = parseWatch(row);
        const matched = await matchRecordedPayments(prisma, watch, cursor.ledger);
        await deps.backfillWallet(watch.walletAddress, watch.startLedger, cursor.ledger + 1);
        logger.info(
          { watchId: watch.id, fromLedger: watch.startLedger, matched },
          "watch backfill finished",
        );
      }
      await prisma.watch.update({ where: { id: row.id }, data: { backfillPending: false } });
      done += 1;
    } catch (err) {
      // The flag stays set, so this watch is retried on the next round.
      logger.error({ err, watchId: row.id }, "watch backfill failed");
    }
  }
  return done;
}
