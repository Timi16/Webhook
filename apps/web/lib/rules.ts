import type { Watch } from "./types";

type AmountRule = Watch["amountRule"];
type MemoRule = Watch["memoRule"];

/** "min 50.0000000": the compact form used in tables. */
export function amountRuleShort(rule: AmountRule): string {
  switch (rule.kind) {
    case "any":
      return "any";
    case "range":
      return `range ${rule.min}–${rule.max}`;
    default:
      return `${rule.kind} ${rule.amount}`;
  }
}

/** "amount ≥ 50.0000000 USDC": the sentence form used on detail pages and in the form summary. */
export function amountRuleLong(rule: AmountRule, code: string): string {
  switch (rule.kind) {
    case "any":
      return "any amount";
    case "exact":
      return `amount = ${rule.amount} ${code}`;
    case "min":
      return `amount ≥ ${rule.amount} ${code}`;
    case "max":
      return `amount ≤ ${rule.amount} ${code}`;
    case "range":
      return `${rule.min} ≤ amount ≤ ${rule.max} ${code}`;
  }
}

export function memoRuleShort(rule: MemoRule): string {
  return rule.kind === "equals" ? `equals ${rule.value}` : rule.kind;
}

export function memoRuleLong(rule: MemoRule): string {
  switch (rule.kind) {
    case "any":
      return "any memo";
    case "present":
      return "memo present";
    case "absent":
      return "no memo";
    case "equals":
      return `memo = "${rule.value}"${rule.type === "text" ? "" : ` (${rule.type})`}`;
  }
}

export const assetCodes = (watch: Pick<Watch, "assets">) =>
  watch.assets.map((a) => a.code).join(", ");
