import type { PrismaClient } from "@prisma/client";
import type { Asset } from "@webhook/shared";
import { CHANNELS, type PgListener } from "../db/notify.js";
import type { Logger } from "../lib/logger.js";
import { assetKey } from "../lib/stellar.js";
import { parseWatch, type ParsedWatch } from "./watch.js";

const DEBOUNCE_MS = 500;
const SAFETY_RELOAD_MS = 30_000;

/** In-memory Map<wallet, active watches>. The ingestion loop drops anything not in it. */
export class WatchedSet {
  private byWallet = new Map<string, ParsedWatch[]>();
  private debounce: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly logger: Logger,
  ) {}

  async reload(): Promise<void> {
    const rows = await this.prisma.watch.findMany({ where: { active: true, deletedAt: null } });
    const next = new Map<string, ParsedWatch[]>();
    for (const row of rows) {
      try {
        const watch = parseWatch(row);
        const list = next.get(watch.walletAddress) ?? [];
        list.push(watch);
        next.set(watch.walletAddress, list);
      } catch (err) {
        this.logger.error({ watchId: row.id, err }, "watch has invalid rules, skipping");
      }
    }
    this.byWallet = next;
  }

  /** Reload on NOTIFY watches_changed (debounced) and every 30 s as a safety net. */
  start(listener: PgListener): void {
    const reload = () => {
      this.reload().catch((err: unknown) =>
        this.logger.error({ err }, "watched set reload failed"),
      );
    };
    listener.on(CHANNELS.watchesChanged, () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(reload, DEBOUNCE_MS);
    });
    this.interval = setInterval(reload, SAFETY_RELOAD_MS);
  }

  stop(): void {
    clearTimeout(this.debounce);
    clearInterval(this.interval);
  }

  has(wallet: string): boolean {
    return this.byWallet.has(wallet);
  }

  get(wallet: string): ParsedWatch[] {
    return this.byWallet.get(wallet) ?? [];
  }

  wallets(): string[] {
    return [...this.byWallet.keys()];
  }

  get size(): number {
    return this.byWallet.size;
  }

  /** Every distinct asset used by an active watch. */
  assets(): Asset[] {
    const unique = new Map<string, Asset>();
    for (const watches of this.byWallet.values()) {
      for (const watch of watches)
        for (const asset of watch.assets) unique.set(assetKey(asset), asset);
    }
    return [...unique.values()];
  }
}
