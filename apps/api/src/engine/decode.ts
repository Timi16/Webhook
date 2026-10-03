import { scValToNative, StrKey, type xdr } from "@stellar/stellar-sdk";
import { MAX_STROOPS } from "../lib/amount.js";
import { assetContractId, parseSep11Asset, toBaseAddress } from "../lib/stellar.js";
import type { MemoType, NormalizedPayment } from "./types.js";

/** The parts of an RPC getEvents entry the decoder needs. */
export interface RpcEventLike {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  inSuccessfulContractCall: boolean;
  contractId?: { toString(): string } | string;
  topic: xdr.ScVal[];
  value: xdr.ScVal;
}

function decodeMemo(raw: unknown): { memo: string | null; memoType: MemoType } | null {
  if (raw === undefined || raw === null) return { memo: null, memoType: "none" };
  if (typeof raw === "string") return { memo: raw, memoType: "text" };
  if (typeof raw === "bigint") return { memo: raw.toString(), memoType: "id" };
  if (raw instanceof Uint8Array)
    return { memo: Buffer.from(raw).toString("hex"), memoType: "hash" };
  return null;
}

/**
 * CAP-67 unified event -> NormalizedPayment. Pure. Returns null for anything that is not a
 * successful transfer/mint to a G address emitted by the genuine Stellar Asset Contract.
 *
 * `to_muxed_id` carries the destination's mux ID when it paid an M-address, otherwise the
 * transaction memo: string -> text, u64 -> id, bytes -> hash. The two u64 cases cannot be
 * told apart from the event, so both surface as an ID memo.
 */
export function decodeEvent(
  event: RpcEventLike,
  networkPassphrase: string,
): NormalizedPayment | null {
  if (!event.inSuccessfulContractCall || event.contractId === undefined) return null;

  let topics: unknown[];
  let value: unknown;
  try {
    topics = event.topic.map((t) => scValToNative(t));
    value = scValToNative(event.value);
  } catch {
    return null;
  }

  const kind = topics[0];
  let from: unknown;
  let to: unknown;
  let assetString: unknown;
  if (kind === "transfer" && topics.length === 4) {
    [, from, to, assetString] = topics;
  } else if (kind === "mint" && topics.length === 3) {
    [, to, assetString] = topics;
  } else if (kind === "mint" && topics.length === 4) {
    // Pre-CAP-67 shape: ["mint", admin, to, asset]
    [, from, to, assetString] = topics;
  } else {
    return null;
  }
  if (typeof to !== "string" || typeof assetString !== "string") return null;

  const asset = parseSep11Asset(assetString);
  if (!asset) return null;
  // Any contract can emit a transfer event naming any asset. Only trust the asset's own contract.
  if (assetContractId(asset, networkPassphrase) !== event.contractId.toString()) return null;

  if (kind === "mint" && typeof from !== "string") from = asset.issuer;
  if (typeof from !== "string") return null;

  let amount: unknown;
  let memoRaw: unknown;
  if (typeof value === "bigint") {
    amount = value;
  } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const data = value as Record<string, unknown>;
    amount = data.amount;
    memoRaw = data.to_muxed_id;
  }
  if (typeof amount !== "bigint" || amount <= 0n || amount > MAX_STROOPS) return null;

  const memo = decodeMemo(memoRaw);
  if (!memo) return null;

  const destination = toBaseAddress(to);
  if (!StrKey.isValidEd25519PublicKey(destination.base)) return null;

  const ledgerClosedAt = new Date(event.ledgerClosedAt);
  if (Number.isNaN(ledgerClosedAt.getTime())) return null;

  return {
    eventId: event.id,
    txHash: event.txHash,
    ledger: event.ledger,
    ledgerClosedAt,
    from: toBaseAddress(from).base,
    to: destination.base,
    ...(destination.muxedId !== undefined ? { toMuxedId: destination.muxedId } : {}),
    memo: memo.memo,
    memoType: memo.memoType,
    asset,
    amountStroops: amount,
    eventType: kind,
    source: "rpc",
  };
}
