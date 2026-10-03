import { toBaseAddress } from "../lib/stellar.js";
import type { NormalizedPayment, Outcome, ReasonCode } from "./types.js";
import type { ParsedWatch } from "./watch.js";

type Rules = Pick<ParsedWatch, "assets" | "amountRule" | "memoRule" | "senderAllowlist">;

function assetReason(p: NormalizedPayment, w: Rules): ReasonCode | null {
  if (w.assets.some((a) => a.code === p.asset.code && a.issuer === p.asset.issuer)) return null;
  // Same code from a different issuer is a counterfeit.
  return w.assets.some((a) => a.code === p.asset.code) ? "WRONG_ISSUER" : "WRONG_ASSET";
}

function amountReason(p: NormalizedPayment, w: Rules): ReasonCode | null {
  const rule = w.amountRule;
  const amount = p.amountStroops;
  switch (rule.kind) {
    case "any":
      return null;
    case "exact":
      return amount === rule.stroops ? null : "AMOUNT_NOT_EXACT";
    case "min":
      return amount >= rule.stroops ? null : "AMOUNT_BELOW_MIN";
    case "max":
      return amount <= rule.stroops ? null : "AMOUNT_ABOVE_MAX";
    case "range":
      if (amount < rule.min) return "AMOUNT_BELOW_MIN";
      return amount > rule.max ? "AMOUNT_ABOVE_MAX" : null;
  }
}

function normalizeMemo(type: "text" | "id" | "hash", value: string): string {
  switch (type) {
    case "text":
      return value.trim();
    case "id":
      // Compared as decimal strings: "007" and "7" are the same ID.
      return /^\d+$/.test(value.trim()) ? BigInt(value.trim()).toString() : value.trim();
    case "hash":
      return value.trim().toLowerCase();
  }
}

function memoReason(p: NormalizedPayment, w: Rules): ReasonCode | null {
  const rule = w.memoRule;
  const hasMemo = p.memoType !== "none" && p.memo !== null;
  switch (rule.kind) {
    case "any":
      return null;
    case "present":
      return hasMemo ? null : "MEMO_MISSING";
    case "absent":
      return hasMemo ? "MEMO_NOT_ALLOWED" : null;
    case "equals":
      if (p.memoType === "none" || p.memo === null) return "MEMO_MISSING";
      if (p.memoType !== rule.type) return "MEMO_TYPE_MISMATCH";
      return normalizeMemo(rule.type, p.memo) === normalizeMemo(rule.type, rule.value)
        ? null
        : "MEMO_MISMATCH";
  }
}

function senderReason(p: NormalizedPayment, w: Rules): ReasonCode | null {
  if (w.senderAllowlist.length === 0) return null;
  const from = toBaseAddress(p.from).base;
  return w.senderAllowlist.some((allowed) => toBaseAddress(allowed).base === from)
    ? null
    : "SENDER_NOT_ALLOWED";
}

/** Pure. Collects every failing reason so the dashboard shows the full picture. */
export function evaluateWatch(
  p: NormalizedPayment,
  w: Rules,
): { outcome: Outcome; reasons: ReasonCode[] } {
  const reasons = [
    assetReason(p, w),
    amountReason(p, w),
    memoReason(p, w),
    senderReason(p, w),
  ].filter((r): r is ReasonCode => r !== null);
  return { outcome: reasons.length === 0 ? "VERIFIED" : "REJECTED", reasons };
}
