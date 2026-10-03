import type { Prisma, Watch } from "@prisma/client";
import type { AmountRuleInput, CreateWatchInput, UpdateWatchInput } from "@webhook/shared";
import { parseWatch, type ParsedWatch } from "../../engine/watch.js";
import { fromStroops, toStroops } from "../../lib/amount.js";
import { AppError } from "../../lib/errors.js";
import type { HorizonClient } from "../../lib/horizon.js";
import { assetKey } from "../../lib/stellar.js";
import type { WatchesRepo } from "./repo.js";

// Testnet closes a ledger about every 5 s.
const LEDGERS_PER_HOUR = 720;
// Real ledgers close about every 5 s; 6 s keeps an estimate at or below the real tip.
const CONSERVATIVE_LEDGER_MS = 6_000;

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Resource not found");
}

/** Decimal strings from the API -> stroops (as strings) for the Json column. */
function toStoredAmountRule(rule: AmountRuleInput): Prisma.InputJsonObject {
  switch (rule.kind) {
    case "any":
      return { kind: "any" };
    case "range":
      return {
        kind: "range",
        min: toStroops(rule.min).toString(),
        max: toStroops(rule.max).toString(),
      };
    default:
      return { kind: rule.kind, stroops: toStroops(rule.amount).toString() };
  }
}

/** Amounts go out in both forms: decimal string and stroops. */
function serializeAmountRule(rule: ParsedWatch["amountRule"]) {
  switch (rule.kind) {
    case "any":
      return { kind: rule.kind };
    case "range":
      return {
        kind: rule.kind,
        min: fromStroops(rule.min),
        max: fromStroops(rule.max),
        minStroops: rule.min.toString(),
        maxStroops: rule.max.toString(),
      };
    default:
      return {
        kind: rule.kind,
        amount: fromStroops(rule.stroops),
        stroops: rule.stroops.toString(),
      };
  }
}

export function serializeWatch(row: Watch) {
  const watch = parseWatch(row);
  return {
    id: watch.id,
    walletAddress: watch.walletAddress,
    label: watch.label,
    endpointId: watch.endpointId,
    assets: watch.assets,
    amountRule: serializeAmountRule(watch.amountRule),
    memoRule: watch.memoRule,
    senderAllowlist: watch.senderAllowlist,
    eventTypes: watch.eventTypes,
    startLedger: watch.startLedger,
    active: watch.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Order-insensitive fingerprint of everything that makes two watches "identical". */
function fingerprint(row: Watch): string {
  const w = parseWatch(row);
  return JSON.stringify([
    w.walletAddress,
    w.endpointId,
    w.assets.map(assetKey).sort(),
    serializeAmountRule(w.amountRule),
    w.memoRule,
    [...w.senderAllowlist].sort(),
    [...w.eventTypes].sort(),
  ]);
}

export function createWatchesService(repo: WatchesRepo, horizon: HorizonClient, maxWatches = 100) {
  async function mustFind(developerId: string, id: string): Promise<Watch> {
    const watch = await repo.find(developerId, id);
    if (!watch) throw notFound();
    return watch;
  }

  async function assertEndpoint(developerId: string, endpointId: string): Promise<void> {
    if (!(await repo.endpointExists(developerId, endpointId)))
      throw new AppError("NOT_FOUND", "Endpoint not found");
  }

  /**
   * The newest ledger we know of. Rules take effect from the next one.
   *
   * Horizon's tip is authoritative. Without it, the worker's cursor is extrapolated by its age
   * (slightly slower than real ledgers close, so the estimate never overshoots and a watch
   * never skips payments made after it was created).
   */
  async function currentLedger(): Promise<number> {
    const [cursor, tip] = await Promise.all([repo.cursor(), horizon.latestLedger()]);
    if (tip !== null) return Math.max(cursor?.ledger ?? 0, tip);
    if (!cursor) {
      throw new AppError(
        "INTERNAL",
        "Cannot determine the current ledger: Stellar is unreachable right now. Try again shortly.",
        { status: 503 },
      );
    }
    const ageMs = Math.max(0, Date.now() - cursor.updatedAt.getTime());
    return cursor.ledger + Math.floor(ageMs / CONSERVATIVE_LEDGER_MS);
  }

  /** A missing account or trustline is a warning, not an error: set things up in any order. */
  async function warningsFor(developerId: string, row: Watch): Promise<string[]> {
    const warnings: string[] = [];
    const watch = parseWatch(row);
    const account = await horizon.account(watch.walletAddress);
    if (account === null) {
      warnings.push("HORIZON_UNAVAILABLE");
    } else if (!account.exists) {
      warnings.push("ACCOUNT_NOT_FOUND");
    } else {
      const held = new Set(account.assets.map(assetKey));
      for (const asset of watch.assets) {
        if (!held.has(assetKey(asset))) warnings.push(`NO_TRUSTLINE:${asset.code}`);
      }
    }
    const others = await repo.list(developerId, { wallet: watch.walletAddress });
    const mine = fingerprint(row);
    if (others.some((other) => other.id !== row.id && fingerprint(other) === mine)) {
      warnings.push("DUPLICATE_WATCH");
    }
    return warnings;
  }

  return {
    async list(
      developerId: string,
      filter: { wallet?: string | undefined; active?: "true" | "false" | undefined },
    ) {
      const rows = await repo.list(developerId, {
        wallet: filter.wallet,
        active: filter.active === undefined ? undefined : filter.active === "true",
      });
      return { data: rows.map(serializeWatch) };
    },

    async create(developerId: string, input: CreateWatchInput) {
      await assertEndpoint(developerId, input.endpointId);
      if ((await repo.count(developerId)) >= maxWatches) {
        throw new AppError("CONFLICT", `Watch limit reached (${maxWatches}); delete one first`);
      }
      const tip = await currentLedger();
      const startLedger = Math.max(tip + 1 - input.backfillHours * LEDGERS_PER_HOUR, 1);
      const row = await repo.create(
        developerId,
        {
          endpointId: input.endpointId,
          walletAddress: input.walletAddress,
          label: input.label ?? null,
          assets: input.assets,
          amountRule: toStoredAmountRule(input.amountRule),
          memoRule: input.memoRule,
          senderAllowlist: input.senderAllowlist,
          eventTypes: input.eventTypes,
          startLedger,
        },
        input.backfillHours > 0 ? startLedger : undefined,
      );
      return { watch: serializeWatch(row), warnings: await warningsFor(developerId, row) };
    },

    async get(developerId: string, id: string) {
      const row = await mustFind(developerId, id);
      return { watch: serializeWatch(row), stats: await repo.stats(developerId, id) };
    },

    /** Applies from the next ledger; events that already exist keep their frozen payload. */
    async update(developerId: string, id: string, input: UpdateWatchInput) {
      await mustFind(developerId, id);
      if (input.endpointId !== undefined) await assertEndpoint(developerId, input.endpointId);
      const row = await repo.update(developerId, id, {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
        ...(input.assets !== undefined ? { assets: input.assets } : {}),
        ...(input.amountRule !== undefined
          ? { amountRule: toStoredAmountRule(input.amountRule) }
          : {}),
        ...(input.memoRule !== undefined ? { memoRule: input.memoRule } : {}),
        ...(input.senderAllowlist !== undefined ? { senderAllowlist: input.senderAllowlist } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      });
      if (!row) throw notFound();
      return { watch: serializeWatch(row), warnings: await warningsFor(developerId, row) };
    },

    async pause(developerId: string, id: string) {
      await mustFind(developerId, id);
      const row = await repo.update(developerId, id, { active: false });
      if (!row) throw notFound();
      return { watch: serializeWatch(row) };
    },

    async resume(developerId: string, id: string) {
      const current = await mustFind(developerId, id);
      if (current.active) return { watch: serializeWatch(current) };
      if (!(await repo.endpointExists(developerId, current.endpointId))) {
        throw new AppError(
          "CONFLICT",
          "This watch's endpoint was deleted; set a new endpointId first",
        );
      }
      // Payments that arrived while paused stay ignored: matching restarts from the next ledger.
      const row = await repo.update(developerId, id, {
        active: true,
        startLedger: (await currentLedger()) + 1,
      });
      if (!row) throw notFound();
      return { watch: serializeWatch(row) };
    },

    /** Soft delete: stops matching immediately, history is kept. */
    async remove(developerId: string, id: string): Promise<void> {
      await mustFind(developerId, id);
      await repo.update(developerId, id, { active: false, deletedAt: new Date() });
    },
  };
}

export type WatchesService = ReturnType<typeof createWatchesService>;
