import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../lib/logger.js";
import { loadCursor } from "./cursor.js";
import { BATCH_LIMIT } from "./ingestion.js";
import { processPayment } from "./matcher.js";
import type { EventCursor, StellarSource } from "./types.js";
import type { WatchedSet } from "./watchedSet.js";

export const RECONCILIATION_INTERVAL_MS = 120_000;
const LOOKBACK_LEDGERS = 60;
const MAX_PAGES = 50;

export interface ReconciliationDeps {
  prisma: PrismaClient;
  source: StellarSource;
  watchedSet: WatchedSet;
  logger: Logger;
}

/**
 * Re-reads the last 60 ledgers up to the cursor and runs every payment through the matcher
 * again. Duplicates hit the primary key and are skipped. Never moves the main cursor.
 */
export async function reconcile(
  deps: ReconciliationDeps,
): Promise<{ scanned: number; recovered: number }> {
  const { prisma, source, watchedSet } = deps;
  const cursor = await loadCursor(prisma);
  if (!cursor || watchedSet.size === 0) return { scanned: 0, recovered: 0 };

  const oldest = await source.oldestLedger();
  let from: EventCursor = { ledger: Math.max(cursor.ledger - LOOKBACK_LEDGERS, oldest) };
  let scanned = 0;
  let recovered = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const { payments, next, fetched } = await source.fetch(from, BATCH_LIMIT);
    const relevant = payments.filter((p) => p.ledger <= cursor.ledger && watchedSet.has(p.to));
    scanned += relevant.length;
    if (relevant.length > 0) {
      await prisma.$transaction(
        async (tx) => {
          for (const p of relevant) {
            const result = await processPayment(tx, p, watchedSet.get(p.to));
            if (result.inserted) recovered += 1;
          }
        },
        { timeout: 15_000 },
      );
    }
    if (fetched < BATCH_LIMIT || next.ledger > cursor.ledger) break;
    from = next;
  }

  if (recovered > 0)
    deps.logger.warn({ recovered }, "reconciliation recovered payments the live loop missed");
  return { scanned, recovered };
}
