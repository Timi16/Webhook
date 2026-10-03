import { Address, TransactionBuilder, xdr, type Memo, type rpc } from "@stellar/stellar-sdk";
import { decodeEvent, sanitizeMemoText } from "../decode.js";
import type {
  EventCursor,
  FetchResult,
  MemoType,
  NormalizedPayment,
  StellarSource,
} from "../types.js";

// RPC limits: at most 5 filters per request and 5 topic filters per filter.
const MAX_FILTERS = 5;
const OLDEST_LEDGER_TTL_MS = 30_000;

const symbol = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");
const TRANSFER = symbol("transfer");
const MINT = symbol("mint");

// transfer: [sym, from, to, asset] · mint: [sym, to, asset] (CAP-67) or [sym, admin, to, asset] (older)
const ALL_PAYMENTS: rpc.Api.EventFilter[] = [
  {
    type: "contract",
    topics: [
      [TRANSFER, "*", "*", "*"],
      [MINT, "*", "*"],
      [MINT, "*", "*", "*"],
    ],
  },
];

/**
 * Filters by destination wallet, never by asset contract: a payment in the wrong asset or from
 * a counterfeit issuer must still be seen so it can be recorded as REJECTED. With more wallets
 * than fit in one request, every transfer and mint is fetched and filtered in memory instead.
 */
export function buildFilters(wallets: string[]): rpc.Api.EventFilter[] {
  if (wallets.length === 0 || wallets.length > MAX_FILTERS) return ALL_PAYMENTS;
  return wallets.map((wallet) => {
    const to = new Address(wallet).toScVal().toXDR("base64");
    return {
      type: "contract",
      topics: [
        [TRANSFER, "*", to, "*"],
        [MINT, to, "*"],
        [MINT, "*", to, "*"],
      ],
    };
  });
}

type RpcClient = Pick<rpc.Server, "getEvents" | "getHealth" | "getLatestLedger" | "getTransaction">;

const TX_CACHE_SIZE = 500;

interface TransactionInfo {
  memo: { memo: string; memoType: MemoType } | null;
  /** Per operation: did it pay a muxed (M...) destination? */
  muxedDestination: boolean[];
}

function memoOf(memo: Memo): TransactionInfo["memo"] {
  const value: unknown = memo.value;
  switch (memo.type) {
    case "text":
      return {
        memo: sanitizeMemoText(
          typeof value === "string" ? value : Buffer.from(value as Uint8Array).toString("utf8"),
        ),
        memoType: "text",
      };
    case "id":
      return { memo: String(value), memoType: "id" };
    case "hash":
    case "return":
      return { memo: Buffer.from(value as Uint8Array).toString("hex"), memoType: "hash" };
    default:
      return null;
  }
}

export class RpcEventSource implements StellarSource {
  private oldest: { ledger: number; at: number } | undefined;
  private readonly transactions = new Map<string, TransactionInfo>();

  constructor(
    private readonly server: RpcClient,
    private readonly networkPassphrase: string,
    private readonly watchedWallets: () => string[],
  ) {}

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async oldestLedger(): Promise<number> {
    if (!this.oldest || Date.now() - this.oldest.at > OLDEST_LEDGER_TTL_MS) {
      this.oldest = { ledger: (await this.server.getHealth()).oldestLedger, at: Date.now() };
    }
    return this.oldest.ledger;
  }

  async fetch(from: EventCursor, limit: number): Promise<FetchResult> {
    const filters = buildFilters(this.watchedWallets());
    const res = await this.server.getEvents(
      from.pagingToken
        ? { cursor: from.pagingToken, filters, limit }
        : { startLedger: from.ledger, filters, limit },
    );
    this.oldest = { ledger: res.oldestLedger, at: Date.now() };

    const payments: NormalizedPayment[] = [];
    for (const event of res.events) {
      const payment = decodeEvent(event, this.networkPassphrase);
      if (payment) payments.push(payment);
    }

    // A full page means more events are waiting; otherwise everything up to the tip was scanned.
    const last = res.events.at(-1);
    const ledger = res.events.length >= limit && last ? last.ledger : res.latestLedger;
    return { payments, next: { ledger, pagingToken: res.cursor }, fetched: res.events.length };
  }

  /**
   * An event's u64 `to_muxed_id` is either the transaction's ID memo or the mux ID of an
   * M-address destination (which also hides the transaction's real memo). The transaction
   * itself says which: for a muxed destination the payment gets `toMuxedId` and the real memo
   * back; the mux ID only stands in as the memo when the transaction has none.
   */
  async resolve(payments: NormalizedPayment[]): Promise<NormalizedPayment[]> {
    const resolved: NormalizedPayment[] = [];
    for (const p of payments) {
      if (p.memoType !== "id" || p.memo === null || p.operationIndex === undefined) {
        resolved.push(p);
        continue;
      }
      const info = await this.transactionInfo(p.txHash);
      if (!info?.muxedDestination[p.operationIndex]) {
        resolved.push(p); // a genuine ID memo
        continue;
      }
      resolved.push({
        ...p,
        toMuxedId: p.memo,
        ...(info.memo ?? { memo: p.memo, memoType: "id" as const }),
      });
    }
    return resolved;
  }

  private async transactionInfo(txHash: string): Promise<TransactionInfo | null> {
    const cached = this.transactions.get(txHash);
    if (cached) return cached;
    const res = await this.server.getTransaction(txHash);
    if (res.status !== "SUCCESS") return null;

    const parsed = TransactionBuilder.fromXDR(res.envelopeXdr, this.networkPassphrase);
    const tx = "innerTransaction" in parsed ? parsed.innerTransaction : parsed;
    const info: TransactionInfo = {
      memo: memoOf(tx.memo),
      muxedDestination: tx.operations.map((op) => {
        // Soroban transactions cannot carry a memo, so a u64 there is always a mux ID.
        if (op.type === "invokeHostFunction") return true;
        return (
          "destination" in op &&
          typeof op.destination === "string" &&
          op.destination.startsWith("M")
        );
      }),
    };
    if (this.transactions.size >= TX_CACHE_SIZE) this.transactions.clear();
    this.transactions.set(txHash, info);
    return info;
  }
}
