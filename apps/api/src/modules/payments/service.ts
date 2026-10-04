import type { ChainPayment } from "@prisma/client";
import { fromStroops } from "../../lib/amount.js";
import { AppError } from "../../lib/errors.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { PaymentFilter, PaymentsRepo } from "./repo.js";

function serializePayment(p: ChainPayment) {
  return {
    id: p.eventId,
    txHash: p.txHash,
    innerTxHash: p.innerTxHash,
    ledger: p.ledger,
    ledgerClosedAt: p.ledgerClosedAt.toISOString(),
    from: p.fromAddress,
    to: p.toAddress,
    toMuxedId: p.toMuxedId,
    memo: p.memo,
    memoType: p.memoType,
    asset: { code: p.assetCode, issuer: p.assetIssuer },
    amount: fromStroops(p.amountStroops),
    amountStroops: p.amountStroops.toString(),
    eventType: p.eventType,
    source: p.source,
  };
}

/** Rule-by-rule result, derived from the stored reason codes. */
function checks(reasons: string[]) {
  const failed = (prefix: string) => reasons.filter((r) => r.startsWith(prefix));
  const check = (list: string[]) => ({ passed: list.length === 0, reason: list[0] ?? null });
  return {
    asset: check(failed("WRONG_")),
    amount: check(failed("AMOUNT_")),
    memo: check(failed("MEMO_")),
    sender: check(failed("SENDER_")),
  };
}

export function createPaymentsService(repo: PaymentsRepo) {
  return {
    async list(
      developerId: string,
      query: {
        watchId?: string | undefined;
        wallet?: string | undefined;
        outcome?: "VERIFIED" | "REJECTED" | undefined;
        asset?: string | undefined;
        q?: string | undefined;
        from?: string | undefined;
        to?: string | undefined;
        cursor?: string | undefined;
        limit: number;
      },
    ) {
      const filter: PaymentFilter = {
        watchId: query.watchId,
        wallet: query.wallet,
        outcome: query.outcome,
        asset: query.asset,
        q: query.q,
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      };
      const rows = await repo.list(developerId, filter, decodeCursor(query.cursor), query.limit);
      const page = toPage(rows, query.limit, (row) => ({
        createdAt: row.createdAt,
        id: row.eventId,
      }));
      return {
        data: page.data.map((row) => ({
          ...serializePayment(row),
          matches: row.matches.map((m) => ({
            watchId: m.watchId,
            outcome: m.outcome,
            reasons: m.reasons,
            eventId: m.event?.id ?? null,
          })),
        })),
        nextCursor: page.nextCursor,
      };
    },

    async get(developerId: string, eventId: string) {
      const row = await repo.find(developerId, eventId);
      if (!row) throw new AppError("NOT_FOUND", "Resource not found");
      return {
        payment: {
          ...serializePayment(row),
          matches: row.matches.map((m) => ({
            watchId: m.watchId,
            watchLabel: m.watch.label,
            outcome: m.outcome,
            reasons: m.reasons,
            checks: checks(m.reasons),
            event: m.event
              ? {
                  id: m.event.id,
                  type: m.event.type,
                  createdAt: m.event.createdAt.toISOString(),
                  deliveries: m.event.deliveries.map((d) => ({
                    id: d.id,
                    status: d.status,
                    attemptCount: d.attemptCount,
                    deliveredAt: d.deliveredAt?.toISOString() ?? null,
                  })),
                }
              : null,
          })),
        },
      };
    },
  };
}

export type PaymentsService = ReturnType<typeof createPaymentsService>;
