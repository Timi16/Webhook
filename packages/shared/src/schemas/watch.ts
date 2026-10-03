import { z } from "zod";
import { AMOUNT_PATTERN, MAX_STROOPS, toStroops } from "../amount.js";
import { isValidContractAddress, isValidPublicKey, isValidSecretSeed } from "../strkey.js";

/** Issue message that the API turns into a SECRET_KEY_REJECTED error. */
export const SECRET_KEY_ISSUE = "secret_key_rejected";

function stellarAddress(isValid: (v: string) => boolean) {
  return z.string().superRefine((value, ctx) => {
    if (isValidSecretSeed(value)) ctx.addIssue({ code: "custom", message: SECRET_KEY_ISSUE });
    else if (!isValid(value)) ctx.addIssue({ code: "custom", message: "invalid_stellar_address" });
  });
}

/** Base G address only. */
export const walletAddressSchema = stellarAddress(isValidPublicKey);
/** Senders can be accounts (G) or contract wallets (C). */
export const senderAddressSchema = stellarAddress(
  (v) => isValidPublicKey(v) || isValidContractAddress(v),
);

export const assetSchema = z
  .strictObject({
    code: z.string().regex(/^[A-Za-z0-9]{1,12}$/, "invalid_asset_code"),
    issuer: walletAddressSchema.nullable(),
  })
  .refine((a) => a.issuer !== null || a.code === "XLM", {
    error: "issuer_required",
    path: ["issuer"],
  });
export type Asset = z.infer<typeof assetSchema>;

export const amountStringSchema = z
  .string()
  .regex(AMOUNT_PATTERN, "invalid_amount")
  .refine(
    (v) => {
      if (!AMOUNT_PATTERN.test(v)) return true; // already reported by the regex
      const [whole = "0", fraction = ""] = v.split(".");
      const stroops = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
      return stroops > 0n && stroops <= MAX_STROOPS;
    },
    { error: "amount_out_of_range" },
  );

/** Amount rule as sent to the API: decimal strings. */
export const amountRuleInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.literal("exact"), amount: amountStringSchema }),
  z.strictObject({ kind: z.literal("min"), amount: amountStringSchema }),
  z.strictObject({ kind: z.literal("max"), amount: amountStringSchema }),
  z
    .strictObject({ kind: z.literal("range"), min: amountStringSchema, max: amountStringSchema })
    .refine(
      (r) =>
        !AMOUNT_PATTERN.test(r.min) ||
        !AMOUNT_PATTERN.test(r.max) ||
        toStroops(r.min) <= toStroops(r.max),
      { error: "min_greater_than_max", path: ["min"] },
    ),
]);
export type AmountRuleInput = z.infer<typeof amountRuleInputSchema>;

const stroopsSchema = z
  .string()
  .regex(/^\d{1,19}$/)
  .transform((v) => BigInt(v));

/** Amount rule as stored in Watch.amountRule (stroops as strings), parsed to bigint on read. */
export const storedAmountRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.literal("exact"), stroops: stroopsSchema }),
  z.strictObject({ kind: z.literal("min"), stroops: stroopsSchema }),
  z.strictObject({ kind: z.literal("max"), stroops: stroopsSchema }),
  z.strictObject({ kind: z.literal("range"), min: stroopsSchema, max: stroopsSchema }),
]);
export type AmountRule = z.infer<typeof storedAmountRuleSchema>;

export const memoTypeSchema = z.enum(["text", "id", "hash"]);

const memoEqualsSchema = z
  .strictObject({
    kind: z.literal("equals"),
    value: z.string().min(1),
    type: memoTypeSchema,
  })
  .superRefine((rule, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message, path: ["value"] });
    if (rule.type === "text" && new TextEncoder().encode(rule.value).length > 28) {
      fail("memo_text_too_long");
    }
    if (rule.type === "id" && !(/^\d{1,20}$/.test(rule.value) && BigInt(rule.value) < 2n ** 64n)) {
      fail("invalid_memo_id");
    }
    if (rule.type === "hash" && !/^[0-9a-fA-F]{64}$/.test(rule.value)) fail("invalid_memo_hash");
  });

export const memoRuleSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.literal("present") }),
  z.strictObject({ kind: z.literal("absent") }),
  memoEqualsSchema,
]);
export type MemoRule = z.infer<typeof memoRuleSchema>;

export const WATCH_EVENT_TYPES = ["payment.received", "payment.rejected"] as const;
export const watchEventTypeSchema = z.enum(WATCH_EVENT_TYPES);

const watchFields = {
  label: z.string().trim().min(1).max(100).nullable().optional(),
  endpointId: z.string().min(1).max(64),
  assets: z.array(assetSchema).min(1).max(10),
  amountRule: amountRuleInputSchema,
  memoRule: memoRuleSchema,
  senderAllowlist: z.array(senderAddressSchema).max(50),
  eventTypes: z.array(watchEventTypeSchema).min(1).max(2),
};

export const createWatchSchema = z.strictObject({
  walletAddress: walletAddressSchema,
  ...watchFields,
  amountRule: watchFields.amountRule.default({ kind: "any" }),
  memoRule: watchFields.memoRule.default({ kind: "any" }),
  senderAllowlist: watchFields.senderAllowlist.default([]),
  eventTypes: watchFields.eventTypes.default(["payment.received"]),
  backfillHours: z.number().int().min(0).max(24).default(0),
});
export type CreateWatchInput = z.infer<typeof createWatchSchema>;

/** Any create field except walletAddress. */
export const updateWatchSchema = z.strictObject(watchFields).partial();
export type UpdateWatchInput = z.infer<typeof updateWatchSchema>;
