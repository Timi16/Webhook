// Money is never a float: amounts are bigint stroops in code and strings in JSON.
export const STROOPS_PER_UNIT = 10_000_000n;
export const AMOUNT_DECIMALS = 7;
export const AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,7})?$/;
export const MAX_STROOPS = 9_223_372_036_854_775_807n; // int64, the classic asset limit

export class AmountError extends Error {}

/** "10.5" -> 105000000n. Rejects anything that is not a plain decimal with at most 7 places. */
export function toStroops(amount: string): bigint {
  if (!AMOUNT_PATTERN.test(amount)) throw new AmountError("invalid_amount");
  const [whole = "0", fraction = ""] = amount.split(".");
  const stroops = BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(AMOUNT_DECIMALS, "0"));
  if (stroops > MAX_STROOPS) throw new AmountError("amount_too_large");
  return stroops;
}

/** 105000000n -> "10.5000000". Always 7 decimal places. */
export function fromStroops(stroops: bigint): string {
  if (stroops < 0n) throw new AmountError("negative_amount");
  const whole = stroops / STROOPS_PER_UNIT;
  const fraction = (stroops % STROOPS_PER_UNIT).toString().padStart(AMOUNT_DECIMALS, "0");
  return `${whole}.${fraction}`;
}
