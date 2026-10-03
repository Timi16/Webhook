import { StrKey } from "@stellar/stellar-sdk";
import type { Asset } from "@webhook/shared";
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
  into: z.string().optional(),
  claimant: z.string().optional(),
  balance_id: z.string().optional(),
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
  // Same rule as the RPC source: the transaction memo wins; a muxed destination's ID stands in
  // as an ID memo only when the transaction has none.
  const muxed = record.to_muxed_id ? { toMuxedId: record.to_muxed_id } : {};
  const tx = record.transaction;
  if (!tx?.memo || !tx.memo_type || tx.memo_type === "none") {
    return record.to_muxed_id
      ? { memo: record.to_muxed_id, memoType: "id", ...muxed }
      : { memo: null, memoType: "none" };
  }
  switch (tx.memo_type) {
    case "text":
      return { memo: sanitizeMemoText(tx.memo), memoType: "text", ...muxed };
    case "id":
      return { memo: tx.memo, memoType: "id", ...muxed };
    case "hash":
    case "return":
      return { memo: Buffer.from(tx.memo, "base64").toString("hex"), memoType: "hash", ...muxed };
    default:
      return { memo: null, memoType: "none", ...muxed };
  }
}

function assetOf(part: { asset_type?: string; asset_code?: string; asset_issuer?: string }) {
  if (part.asset_type === "native") return XLM;
  if (part.asset_code && part.asset_issuer)
    return { code: part.asset_code, issuer: part.asset_issuer };
  return null;
}

/**
 * Horizon's balance ID is the XDR form: a 4-byte type (0 = v0) followed by the 32-byte hash.
 * The B... address encodes a 1-byte type followed by the same hash.
 */
function claimableBalanceAddress(balanceId: string): string {
  return StrKey.encodeClaimableBalance(Buffer.from(`00${balanceId.slice(8)}`, "hex"));
}

/** What an operation credited to the wallet, taken from its effects. */
export interface Credit {
  amount: string;
  asset: Asset | null;
}

/** Operation types whose record has no amount; it has to come from the operation's effects. */
const NEEDS_EFFECTS = new Set(["account_merge", "claim_claimable_balance"]);

/**
 * Maps one Horizon operation record to the payments it made to `wallet`. Pure.
 * `credits` is only used for account merges and claimable-balance claims.
 */
export function mapHorizonRecord(
  raw: unknown,
  wallet: string,
  credits: Credit[] = [],
): NormalizedPayment[] {
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return [];
  const record = parsed.data;
  if (!record.transaction_successful || !record.transaction) return [];

  const transfers: {
    from: string;
    to: string;
    amount: string;
    asset: Asset | null;
    key: string;
  }[] = [];
  const credited = (from: string, to: string) =>
    credits.forEach((credit, index) =>
      transfers.push({
        from,
        to,
        amount: credit.amount,
        asset: credit.asset,
        key: index === 0 ? "" : `-${index}`,
      }),
    );
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
    case "account_merge":
      // The merged account's whole XLM balance moves to `into`.
      if (record.account && record.into) credited(record.account, record.into);
      break;
    case "claim_claimable_balance":
      // The sender is the claimable balance itself (its B... address), exactly as in the RPC event.
      if (
        record.claimant &&
        record.balance_id &&
        /^00000000[0-9a-f]{64}$/.test(record.balance_id)
      ) {
        credited(claimableBalanceAddress(record.balance_id), record.claimant);
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
    default:
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

const headSchema = z.object({ id: z.string(), type: z.string(), paging_token: z.string() });
const effectSchema = z.object({
  type: z.string(),
  account: z.string().optional(),
  amount: z.string().optional(),
  asset_type: z.string().optional(),
  asset_code: z.string().optional(),
  asset_issuer: z.string().optional(),
});
const transactionSchema = z.object({ envelope_xdr: z.string() });

type Feed = "payments" | "operations";

export class HorizonBackfillSource {
  constructor(
    private readonly horizonUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * A wallet's incoming payments for ledgers in [fromLedger, toLedgerExclusive), a page at a time.
   * Horizon's payments feed covers payments, path payments, account creation, merges and
   * contract transfers. Claims of claimable balances are only in the operations feed, so that
   * is paged as well, for claims alone.
   */
  async *paymentsForWallet(
    wallet: string,
    fromLedger: number,
    toLedgerExclusive: number,
  ): AsyncGenerator<NormalizedPayment[]> {
    yield* this.feed(
      "payments",
      wallet,
      fromLedger,
      toLedgerExclusive,
      (type) => type !== "claim_claimable_balance",
    );
    yield* this.feed(
      "operations",
      wallet,
      fromLedger,
      toLedgerExclusive,
      (type) => type === "claim_claimable_balance",
    );
  }

  /** The transaction envelope (base64 XDR), or null if Horizon does not know the transaction. */
  async transactionEnvelope(txHash: string): Promise<string | null> {
    const res = await this.get(`/transactions/${txHash}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon responded ${res.status} for transaction ${txHash}`);
    return transactionSchema.parse(await res.json()).envelope_xdr;
  }

  private get(path: string, params: Record<string, string> = {}): Promise<Response> {
    const url = new URL(path, this.horizonUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return this.fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  }

  /** What the operation credited to the wallet, from its effects. */
  private async credits(operationId: string, wallet: string): Promise<Credit[]> {
    const res = await this.get(`/operations/${operationId}/effects`, { limit: "50" });
    if (!res.ok)
      throw new Error(`Horizon responded ${res.status} for effects of operation ${operationId}`);
    const credits: Credit[] = [];
    for (const raw of pageSchema.parse(await res.json())._embedded.records) {
      const effect = effectSchema.safeParse(raw);
      if (
        effect.success &&
        effect.data.type === "account_credited" &&
        effect.data.account === wallet &&
        effect.data.amount
      ) {
        credits.push({ amount: effect.data.amount, asset: assetOf(effect.data) });
      }
    }
    return credits;
  }

  private async *feed(
    feed: Feed,
    wallet: string,
    fromLedger: number,
    toLedgerExclusive: number,
    accept: (type: string) => boolean,
  ): AsyncGenerator<NormalizedPayment[]> {
    // Horizon paging tokens are TOIDs: ledger << 32 | txIndex << 12 | opIndex.
    let cursor = (BigInt(Math.max(fromLedger, 0)) << 32n).toString();
    for (;;) {
      const res = await this.get(`/accounts/${wallet}/${feed}`, {
        join: "transactions",
        order: "asc",
        limit: String(PAGE_SIZE),
        cursor,
      });
      if (res.status === 404) return; // account does not exist (yet)
      if (!res.ok) throw new Error(`Horizon responded ${res.status} for ${feed} of ${wallet}`);
      const records = pageSchema.parse(await res.json())._embedded.records;
      if (records.length === 0) return;

      const page: NormalizedPayment[] = [];
      let reachedEnd = false;
      let lastToken: string | undefined;
      for (const raw of records) {
        const head = headSchema.safeParse(raw);
        if (!head.success) continue;
        lastToken = head.data.paging_token;
        if (BigInt(head.data.paging_token) >> 32n >= BigInt(toLedgerExclusive)) {
          reachedEnd = true;
          break;
        }
        if (!accept(head.data.type)) continue;
        const credits = NEEDS_EFFECTS.has(head.data.type)
          ? await this.credits(head.data.id, wallet)
          : [];
        for (const payment of mapHorizonRecord(raw, wallet, credits)) {
          if (payment.ledger >= fromLedger && payment.ledger < toLedgerExclusive)
            page.push(payment);
        }
      }
      if (page.length > 0) yield page;
      if (reachedEnd || records.length < PAGE_SIZE || !lastToken) return;
      cursor = lastToken;
    }
  }
}
