import type { PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify.js";
import type { Logger } from "../lib/logger.js";
import { loadCursor, loadNetworkGeneration, saveCursor, tagPayment } from "./cursor.js";
import { processPayment, type EndpointEvents } from "./matcher.js";
import type { HorizonBackfillSource } from "./sources/horizonBackfill.js";
import type { EventCursor, StellarSource } from "./types.js";
import type { WatchedSet } from "./watchedSet.js";

export const BATCH_LIMIT = 200;
const POLL_INTERVAL_MS = 2_000;
const RESET_THRESHOLD_LEDGERS = 100;
/** How long the network must keep looking reset before we act on it. */
const RESET_CONFIRM_MS = 60_000;
const TX_TIMEOUT_MS = 15_000;
/** A single event is given this long: with a batch of one there is nothing left to shrink. */
const SINGLE_EVENT_TIMEOUT_MS = 120_000;
const MAX_BACKOFF_MS = 30_000;
const BUSY_WALLET_EVENTS_PER_MIN = 600;

export interface IngestionDeps {
  prisma: PrismaClient;
  source: StellarSource;
  backfill: HorizonBackfillSource;
  watchedSet: WatchedSet;
  networkPassphrase: string;
  logger: Logger;
  onNetworkReset: (tip: number) => Promise<void>;
  /** Default one minute. Tests pass 0 to act on the first reading. */
  resetConfirmMs?: number;
}

export class Ingestion {
  /** Time of the last completed loop; the watchdog restarts the worker if it goes stale. */
  heartbeat = Date.now();
  /** When the tip first looked far behind the cursor; cleared as soon as it looks normal again. */
  private resetSuspectedAt: number | null = null;
  /**
   * How many events the next pass reads. It halves each time a batch cannot be committed (a
   * wallet with very many watches can make a full batch outlast the transaction timeout, and the
   * same batch would fail for ever) and doubles back after each batch that commits.
   */
  private batchLimit = BATCH_LIMIT;
  private readonly busy = new Map<
    string,
    { windowStart: number; count: number; warned: boolean }
  >();

  constructor(private readonly deps: IngestionDeps) {}

  /** One pass of the main loop. Returns how long to sleep before the next one. */
  async tick(): Promise<number> {
    const { prisma, source, watchedSet, networkPassphrase } = this.deps;

    const tip = await source.latestLedger();
    let cursor = await loadCursor(prisma);
    if (!cursor) {
      // First boot: start at the tip, not genesis.
      cursor = { ledger: tip };
      await saveCursor(prisma, cursor, networkPassphrase);
    }

    if (tip < cursor.ledger - RESET_THRESHOLD_LEDGERS) {
      // One reading far behind is not a reset: an RPC node that is itself lagging answers the
      // same way. Acting on it would rewind the cursor, tell every endpoint the network was
      // reset and send every payment in the re-read range again. So the reading has to hold.
      this.resetSuspectedAt ??= Date.now();
      this.heartbeat = Date.now();
      if (Date.now() - this.resetSuspectedAt < (this.deps.resetConfirmMs ?? RESET_CONFIRM_MS)) {
        this.deps.logger.warn(
          { tip, cursor: cursor.ledger },
          "ledger tip is far behind the cursor; waiting to see if it is a network reset",
        );
        return POLL_INTERVAL_MS;
      }
      this.resetSuspectedAt = null;
      await this.deps.onNetworkReset(tip);
      this.heartbeat = Date.now();
      return 0;
    }
    this.resetSuspectedAt = null;

    const oldest = await source.oldestLedger();
    if (cursor.ledger < oldest) {
      await this.backfillGap(cursor.ledger, oldest);
      await saveCursor(prisma, { ledger: oldest }, networkPassphrase);
      this.heartbeat = Date.now();
      return 0;
    }

    const limit = this.batchLimit;
    const { payments, next, fetched } = await source.fetch(cursor, limit);
    const generation = await loadNetworkGeneration(prisma);
    const watched = payments.filter((p) => watchedSet.has(p.to));
    const relevant = (source.resolve ? await source.resolve(watched) : watched).map((p) =>
      tagPayment(p, generation),
    );

    try {
      await prisma.$transaction(
        async (tx) => {
          const endpoints: EndpointEvents = new Map();
          for (const p of relevant)
            await processPayment(tx, p, watchedSet.get(p.to), new Date(), endpoints);
          await saveCursor(tx, next, networkPassphrase); // saved even when nothing was relevant
        },
        { timeout: limit === 1 ? SINGLE_EVENT_TIMEOUT_MS : TX_TIMEOUT_MS },
      );
    } catch (err) {
      // Nothing was committed and the cursor has not moved: the next pass re-reads from the same
      // place with half as many events.
      if (limit > 1) {
        this.batchLimit = Math.max(1, Math.floor(limit / 2));
        this.deps.logger.warn(
          { from: limit, to: this.batchLimit },
          "batch could not be committed, reading fewer events next time",
        );
      }
      throw err;
    }
    this.batchLimit = Math.min(BATCH_LIMIT, limit * 2);

    await this.warnBusyWallets(relevant.map((p) => p.to));
    this.heartbeat = Date.now();
    return fetched >= limit ? 0 : POLL_INTERVAL_MS;
  }

  /** Runs until aborted. Errors never advance the cursor; they back off 1 s, 2 s, 4 s ... 30 s. */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = 1_000;
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = await this.tick();
        backoff = 1_000;
      } catch (err) {
        this.deps.logger.error({ err, retryInMs: backoff }, "ingestion pass failed");
        wait = backoff;
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
        // The loop itself is alive (it is backing off), so the watchdog must not restart the worker;
        // an unreachable RPC shows up as lag and raises the lag alert instead.
        this.heartbeat = Date.now();
      }
      if (wait > 0) await sleep(wait, signal);
    }
  }

  /** The cursor fell out of RPC's retention window: fill [from, to) from Horizon, wallet by wallet. */
  async backfillGap(fromLedger: number, toLedgerExclusive: number): Promise<void> {
    const { watchedSet, logger } = this.deps;
    logger.warn(
      { fromLedger, toLedgerExclusive },
      "cursor is behind RPC retention, backfilling from Horizon",
    );
    for (const wallet of watchedSet.wallets())
      await this.backfillWallet(wallet, fromLedger, toLedgerExclusive, true);
  }

  /**
   * `fromMainLoop` is true only for the retention-gap backfill, which runs inside the main loop:
   * its pages are that loop's progress. A watch backfill runs beside the loop and must not
   * refresh the heartbeat, or a stuck loop would be hidden from the watchdog.
   */
  async backfillWallet(
    wallet: string,
    fromLedger: number,
    toLedgerExclusive: number,
    fromMainLoop = false,
  ): Promise<void> {
    const { prisma, backfill, watchedSet } = this.deps;
    if (fromMainLoop) this.heartbeat = Date.now();
    const generation = await loadNetworkGeneration(prisma);
    for await (const page of backfill.paymentsForWallet(wallet, fromLedger, toLedgerExclusive)) {
      if (fromMainLoop) this.heartbeat = Date.now(); // the watchdog must not restart us mid-backfill
      await prisma.$transaction(
        async (tx) => {
          const endpoints: EndpointEvents = new Map();
          for (const p of page)
            await processPayment(
              tx,
              tagPayment(p, generation),
              watchedSet.get(p.to),
              new Date(),
              endpoints,
            );
        },
        { timeout: TX_TIMEOUT_MS },
      );
    }
  }

  /** W14: a very busy wallet is never dropped, but its owners get a dashboard notice. */
  private async warnBusyWallets(wallets: string[]): Promise<void> {
    const now = Date.now();
    for (const wallet of wallets) {
      let entry = this.busy.get(wallet);
      if (!entry || now - entry.windowStart > 60_000) {
        entry = { windowStart: now, count: 0, warned: false };
        this.busy.set(wallet, entry);
      }
      entry.count += 1;
      if (entry.count > BUSY_WALLET_EVENTS_PER_MIN && !entry.warned) {
        entry.warned = true;
        const developerIds = new Set(this.deps.watchedSet.get(wallet).map((w) => w.developerId));
        for (const developerId of developerIds) {
          await notify(this.deps.prisma, CHANNELS.notices, {
            developerId,
            kind: "BUSY_WALLET",
            wallet,
          });
        }
        this.deps.logger.warn({ wallet }, "wallet received more than 600 events in a minute");
      }
    }
    if (this.busy.size > 10_000) this.busy.clear();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export type { EventCursor };
