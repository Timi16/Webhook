import { z } from "zod";
import { toStroops } from "../../lib/amount.js";
import { XLM } from "../../lib/stellar.js";
import { sanitizeMemoText } from "../decode.js";
import type { MemoType, NormalizedPayment } from "../types.js";

const PAGE_SIZE = 200;

const balanceChangeSchema = z.object({
  type: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  amount: z.string().optional(),
  asset_type: z.string().optional(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
});

const recordSchema = z.object({
  id: z.string(),
  paging_token: z.string(),
  type: z.string(),
  transaction_successful: z.boolean(),
  transaction_hash: z.string(),
  created_at: z.string(),
  from: z.string().optional(),
  to: z.string().optional(),
  to_muxed_id: z.string().optional(),
  amount: z.string().optional(),
  asset_type: z.string().optional(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
  funder: z.string().optional(),
  account: z.string().optional(),
  starting_balance: z.string().optional(),
  asset_balance_changes: z.array(balanceChangeSchema).optional(),
  transaction: z
    .object({
      ledger: z.number().int(),
      memo_type: z.string().optional(),
      memo: z.string().optional(),
      inner_transaction: z.object({ hash: z.string() }).optional(),
    })
    .optional(),
});
type HorizonRecord = z.infer<typeof recordSchema>;

const pageSchema = z.object({ _embedded: z.object({ records: z.array(z.unknown()) }) });

function memoOf(record: HorizonRecord): {
  memo: string | null;
  memoType: MemoType;
  toMuxedId?: string;
} {
  // Same precedence as the RPC events: a muxed destination's ID replaces the transaction memo.
  if (record.to_muxed_id) {
    return { memo: record.to_muxed_id, memoType: "id", toMuxedId: record.to_muxed_id };
  }
  const tx = record.transaction;
  if (!tx?.memo) return { memo: null, memoType: "none" };
  switch (tx.memo_type) {
    case "text":
      return { memo: sanitizeMemoText(tx.memo), memoType: "text" };
    case "id":
      return { memo: tx.memo, memoType: "id" };
    case "hash":
    case "return":
      return { memo: Buffer.from(tx.memo, "base64").toString("hex"), memoType: "hash" };
    default:
      return { memo: null, memoType: "none" };
  }
}

function assetOf(part: { asset_type?: string; asset_code?: string; asset_issuer?: string }) {
  if (part.asset_type === "native") return XLM;
  if (part.asset_code && part.asset_issuer)
    return { code: part.asset_code, issuer: part.asset_issuer };
  return null;
}

/** Maps one Horizon payment record to the payments it made to `wallet`. Pure. */
export function mapHorizonRecord(raw: unknown, wallet: string): NormalizedPayment[] {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return [];
  const record = parsed.data;
  if (!record.transaction_successful || !record.transaction) return [];

  const transfers: {
    from: string;
    to: string;
    amount: string;
    asset: ReturnType<typeof assetOf>;
    key: string;
  }[] = [];
  switch (record.type) {
    case "payment":
    case "path_payment_strict_send":
    case "path_payment_strict_receive":
      if (record.from && record.to && record.amount) {
        transfers.push({
          from: record.from,
          to: record.to,
          amount: record.amount,
          asset: assetOf(record),
          key: "",
        });
      }
      break;
    case "create_account":
      if (record.funder && record.account && record.starting_balance) {
        transfers.push({
          from: record.funder,
          to: record.account,
          amount: record.starting_balance,
          asset: XLM,
          key: "",
        });
      }
      break;
    case "invoke_host_function":
      (record.asset_balance_changes ?? []).forEach((change, index) => {
        if (change.type === "transfer" && change.from && change.to && change.amount) {
          transfers.push({
            from: change.from,
            to: change.to,
            amount: change.amount,
            asset: assetOf(change),
            key: `-${index}`,
          });
        }
      });
      break;
    default: // account_merge has no amount on the record; it is rare on testnet and skipped
      break;
  }

  const payments: NormalizedPayment[] = [];
  for (const transfer of transfers) {
    if (transfer.to !== wallet || transfer.from === wallet || !transfer.asset) continue;
    let amountStroops: bigint;
    try {
      amountStroops = toStroops(transfer.amount);
    } catch {
      continue;
    }
    if (amountStroops <= 0n) continue;
    const inner = record.transaction.inner_transaction?.hash;
    payments.push({
      // Derived from the operation ID, so live and backfilled rows never collide.
      eventId: `hz-${record.id}${transfer.key}`,
      txHash: record.transaction_hash,
      ...(inner && inner !== record.transaction_hash ? { innerTxHash: inner } : {}),
      ledger: record.transaction.ledger,
      ledgerClosedAt: new Date(record.created_at),
      from: transfer.from,
      to: transfer.to,
      ...memoOf(record),
      asset: transfer.asset,
      amountStroops,
      eventType:
        transfer.asset.issuer !== null && transfer.from === transfer.asset.issuer
          ? "mint"
          : "transfer",
      source: "horizon",
    });
  }
  return payments;
}

export class HorizonBackfillSource {
  constructor(
    private readonly horizonUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Pages a wallet's payments in ledger order for ledgers in [fromLedger, toLedgerExclusive). */
  async *paymentsForWallet(
    wallet: string,
    fromLedger: number,
    toLedgerExclusive: number,
  ): AsyncGenerator<NormalizedPayment[]> {
    // Horizon paging tokens are TOIDs: ledger << 32 | txIndex << 12 | opIndex.
    let cursor = (BigInt(Math.max(fromLedger, 0)) << 32n).toString();
    for (;;) {
      const url = new URL(`/accounts/${wallet}/payments`, this.horizonUrl);
      url.searchParams.set("join", "transactions");
      url.searchParams.set("order", "asc");
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("cursor", cursor);
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) return; // account does not exist (yet)
      if (!res.ok) throw new Error(`Horizon responded ${res.status} for payments of ${wallet}`);
      const records = pageSchema.parse(await res.json())._embedded.records;
      if (records.length === 0) return;

      const page: NormalizedPayment[] = [];
      let reachedEnd = false;
      for (const raw of records) {
        for (const payment of mapHorizonRecord(raw, wallet)) {
          if (payment.ledger >= toLedgerExclusive) reachedEnd = true;
          else if (payment.ledger >= fromLedger) page.push(payment);
        }
      }
      if (page.length > 0) yield page;

      const last = z.object({ paging_token: z.string() }).safeParse(records.at(-1));
      if (reachedEnd || records.length < PAGE_SIZE || !last.success) return;
      if (BigInt(last.data.paging_token) >> 32n >= BigInt(toLedgerExclusive)) return;
      cursor = last.data.paging_token;
    }
  }
}
