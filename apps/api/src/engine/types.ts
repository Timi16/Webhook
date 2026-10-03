import type { Asset } from "@webhook/shared";

export type MemoType = "none" | "text" | "id" | "hash";

export interface NormalizedPayment {
  eventId: string; // RPC event id (unique)
  txHash: string;
  innerTxHash?: string; // fee-bump inner hash, when present
  ledger: number;
  ledgerClosedAt: Date;
  from: string; // base G (or C for contract wallets)
  to: string; // base G, muxed part stripped
  toMuxedId?: string;
  memo: string | null;
  memoType: MemoType;
  asset: Asset; // issuer null = XLM
  amountStroops: bigint;
  eventType: "transfer" | "mint";
  source: "rpc" | "horizon";
  /** Index of the operation inside its transaction (RPC only); used to resolve muxed destinations. */
  operationIndex?: number;
}

export interface EventCursor {
  ledger: number;
  pagingToken?: string;
}

export interface FetchResult {
  payments: NormalizedPayment[];
  next: EventCursor;
  /** Raw events returned by the source, before decoding; equals the limit when more are waiting. */
  fetched: number;
}

export interface StellarSource {
  latestLedger(): Promise<number>;
  oldestLedger(): Promise<number>; // start of RPC's retention window
  fetch(from: EventCursor, limit: number): Promise<FetchResult>;
  /**
   * Fills in what the event alone cannot say (see RpcEventSource.resolve). Called only for the
   * payments that are about to be recorded.
   */
  resolve?(payments: NormalizedPayment[]): Promise<NormalizedPayment[]>;
}

export type ReasonCode =
  | "WRONG_ASSET"
  | "WRONG_ISSUER"
  | "AMOUNT_NOT_EXACT"
  | "AMOUNT_BELOW_MIN"
  | "AMOUNT_ABOVE_MAX"
  | "MEMO_MISSING"
  | "MEMO_MISMATCH"
  | "MEMO_TYPE_MISMATCH"
  | "MEMO_NOT_ALLOWED"
  | "SENDER_NOT_ALLOWED";

export type Outcome = "VERIFIED" | "REJECTED";
