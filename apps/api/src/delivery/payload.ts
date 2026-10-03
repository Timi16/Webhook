import type { Prisma } from "@prisma/client";
import type { NormalizedPayment, Outcome, ReasonCode } from "../engine/types.js";
import type { ParsedWatch } from "../engine/watch.js";
import { fromStroops } from "../lib/amount.js";

export const API_VERSION = "2026-10-01";

export type WebhookEventType =
  | "payment.received"
  | "payment.rejected"
  | "test.ping"
  | "system.network_reset";

interface Envelope {
  eventId: string;
  type: WebhookEventType;
  createdAt: Date;
}

function envelope({ eventId, type, createdAt }: Envelope, data: Prisma.InputJsonObject) {
  return {
    id: eventId,
    type,
    apiVersion: API_VERSION,
    createdAt: createdAt.toISOString(),
    data,
  } satisfies Prisma.InputJsonObject;
}

/** Built once when the event is created and never rebuilt: retries and resends send this exact payload. */
export function buildPaymentPayload(
  meta: Envelope,
  payment: NormalizedPayment,
  watch: Pick<ParsedWatch, "id" | "label" | "walletAddress">,
  result: { outcome: Outcome; reasons: ReasonCode[] },
): Prisma.InputJsonObject {
  return envelope(meta, {
    payment: {
      id: payment.eventId,
      txHash: payment.txHash,
      ledger: payment.ledger,
      ledgerClosedAt: payment.ledgerClosedAt.toISOString(),
      from: payment.from,
      to: payment.to,
      toMuxedId: payment.toMuxedId ?? null,
      memo: payment.memo,
      memoType: payment.memoType,
      asset: { code: payment.asset.code, issuer: payment.asset.issuer },
      amount: fromStroops(payment.amountStroops),
      amountStroops: payment.amountStroops.toString(),
    },
    watch: { id: watch.id, label: watch.label, walletAddress: watch.walletAddress },
    verification: { outcome: result.outcome, reasons: result.reasons },
  });
}

export function buildPingPayload(meta: Envelope, endpointId: string): Prisma.InputJsonObject {
  return envelope(meta, { endpointId, message: "Test webhook from Webhook" });
}

export function buildNetworkResetPayload(meta: Envelope, newTipLedger: number): Prisma.InputJsonObject {
  return envelope(meta, {
    newTipLedger,
    message:
      "Stellar Testnet was reset. Accounts, trustlines and balances were wiped; re-create your test wallets.",
  });
}
