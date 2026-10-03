import { Account, MuxedAccount } from "@stellar/stellar-sdk";
import {
  memoRuleSchema,
  storedAmountRuleSchema,
  type AmountRule,
  type MemoRule,
} from "@webhook/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateWatch } from "../../src/engine/evaluate.js";
import { makePayment, makeRules, randomAddress, USDC, XLM } from "../helpers/payments.js";

const amountRule = (raw: unknown): AmountRule => storedAmountRuleSchema.parse(raw);
const memoRule = (raw: unknown): MemoRule => memoRuleSchema.parse(raw);

describe("evaluateWatch", () => {
  it("W1: payment that passes every rule is VERIFIED with no reasons", () => {
    const sender = randomAddress();
    const result = evaluateWatch(
      makePayment({ from: sender, memo: "order-1", memoType: "text", amountStroops: 100_000_000n }),
      makeRules({
        amountRule: amountRule({ kind: "exact", stroops: "100000000" }),
        memoRule: memoRule({ kind: "equals", value: "order-1", type: "text" }),
        senderAllowlist: [sender],
      }),
    );
    expect(result).toEqual({ outcome: "VERIFIED", reasons: [] });
  });

  it("W2: collects every failing reason instead of stopping at the first", () => {
    const result = evaluateWatch(
      makePayment({ asset: XLM, amountStroops: 5n }),
      makeRules({
        amountRule: amountRule({ kind: "min", stroops: "10" }),
        memoRule: memoRule({ kind: "present" }),
        senderAllowlist: [randomAddress()],
      }),
    );
    expect(result.outcome).toBe("REJECTED");
    expect(result.reasons).toEqual([
      "WRONG_ASSET",
      "AMOUNT_BELOW_MIN",
      "MEMO_MISSING",
      "SENDER_NOT_ALLOWED",
    ]);
  });

  it("W3: USDC from a different issuer is rejected as WRONG_ISSUER", () => {
    const fake = { code: "USDC", issuer: randomAddress() };
    expect(evaluateWatch(makePayment({ asset: fake }), makeRules())).toEqual({
      outcome: "REJECTED",
      reasons: ["WRONG_ISSUER"],
    });
  });

  it("accepts any of several watched assets", () => {
    const rules = makeRules({ assets: [USDC, XLM] });
    expect(evaluateWatch(makePayment({ asset: XLM }), rules).outcome).toBe("VERIFIED");
    expect(evaluateWatch(makePayment({ asset: USDC }), rules).outcome).toBe("VERIFIED");
  });

  it("W12: amounts exactly on the min, max and range edges pass (inclusive)", () => {
    const at = (stroops: bigint, rule: unknown) =>
      evaluateWatch(
        makePayment({ amountStroops: stroops }),
        makeRules({ amountRule: amountRule(rule) }),
      );
    expect(at(100n, { kind: "min", stroops: "100" }).outcome).toBe("VERIFIED");
    expect(at(99n, { kind: "min", stroops: "100" }).reasons).toEqual(["AMOUNT_BELOW_MIN"]);
    expect(at(100n, { kind: "max", stroops: "100" }).outcome).toBe("VERIFIED");
    expect(at(101n, { kind: "max", stroops: "100" }).reasons).toEqual(["AMOUNT_ABOVE_MAX"]);
    expect(at(100n, { kind: "range", min: "100", max: "200" }).outcome).toBe("VERIFIED");
    expect(at(200n, { kind: "range", min: "100", max: "200" }).outcome).toBe("VERIFIED");
    expect(at(99n, { kind: "range", min: "100", max: "200" }).reasons).toEqual([
      "AMOUNT_BELOW_MIN",
    ]);
    expect(at(201n, { kind: "range", min: "100", max: "200" }).reasons).toEqual([
      "AMOUNT_ABOVE_MAX",
    ]);
    expect(at(101n, { kind: "exact", stroops: "100" }).reasons).toEqual(["AMOUNT_NOT_EXACT"]);
  });

  it("W11: ID memos compare as decimal strings and hash memos as case-insensitive hex", () => {
    const idRule = makeRules({ memoRule: memoRule({ kind: "equals", value: "007", type: "id" }) });
    expect(evaluateWatch(makePayment({ memo: "7", memoType: "id" }), idRule).outcome).toBe(
      "VERIFIED",
    );
    expect(evaluateWatch(makePayment({ memo: "8", memoType: "id" }), idRule).reasons).toEqual([
      "MEMO_MISMATCH",
    ]);
    expect(evaluateWatch(makePayment({ memo: "7", memoType: "text" }), idRule).reasons).toEqual([
      "MEMO_TYPE_MISMATCH",
    ]);

    const hash = "AB".repeat(32);
    const hashRule = makeRules({
      memoRule: memoRule({ kind: "equals", value: hash, type: "hash" }),
    });
    expect(
      evaluateWatch(makePayment({ memo: hash.toLowerCase(), memoType: "hash" }), hashRule).outcome,
    ).toBe("VERIFIED");
  });

  it("applies the memo rules: equals (trimmed), present, absent", () => {
    const equals = makeRules({
      memoRule: memoRule({ kind: "equals", value: "inv-9", type: "text" }),
    });
    expect(evaluateWatch(makePayment({ memo: " inv-9 ", memoType: "text" }), equals).outcome).toBe(
      "VERIFIED",
    );
    expect(evaluateWatch(makePayment(), equals).reasons).toEqual(["MEMO_MISSING"]);
    const absent = makeRules({ memoRule: memoRule({ kind: "absent" }) });
    expect(evaluateWatch(makePayment({ memo: "x", memoType: "text" }), absent).reasons).toEqual([
      "MEMO_NOT_ALLOWED",
    ]);
    expect(evaluateWatch(makePayment(), absent).outcome).toBe("VERIFIED");
  });

  it("W13: allowlisted sender is compared on the base address", () => {
    const sender = randomAddress();
    const muxed = new MuxedAccount(new Account(sender, "0"), "99").accountId();
    const rules = makeRules({ senderAllowlist: [sender] });
    expect(evaluateWatch(makePayment({ from: muxed }), rules).outcome).toBe("VERIFIED");
    expect(evaluateWatch(makePayment({ from: sender }), rules).outcome).toBe("VERIFIED");
    expect(evaluateWatch(makePayment(), rules).reasons).toEqual(["SENDER_NOT_ALLOWED"]);
  });

  it("never throws on any valid input", () => {
    const stroops = fc.bigInt({ min: 1n, max: 2n ** 63n - 1n });
    const memo = fc.oneof(
      fc.constant({ memo: null, memoType: "none" as const }),
      fc.string().map((m) => ({ memo: m, memoType: "text" as const })),
      fc
        .bigInt({ min: 0n, max: 2n ** 64n - 1n })
        .map((m) => ({ memo: m.toString(), memoType: "id" as const })),
    );
    const amountRules = fc.oneof(
      fc.constant<AmountRule>({ kind: "any" }),
      stroops.map((s): AmountRule => ({ kind: "exact", stroops: s })),
      stroops.map((s): AmountRule => ({ kind: "min", stroops: s })),
      fc
        .tuple(stroops, stroops)
        .map(([a, b]): AmountRule => ({ kind: "range", min: a < b ? a : b, max: a < b ? b : a })),
    );
    const memoRules = fc.oneof(
      fc.constantFrom<MemoRule>({ kind: "any" }, { kind: "present" }, { kind: "absent" }),
      fc.string().map((v): MemoRule => ({ kind: "equals", value: v, type: "text" })),
      fc.string().map((v): MemoRule => ({ kind: "equals", value: v, type: "id" })),
    );
    fc.assert(
      fc.property(
        stroops,
        memo,
        amountRules,
        memoRules,
        fc.boolean(),
        (amount, m, ar, mr, native) => {
          const result = evaluateWatch(
            makePayment({ amountStroops: amount, ...m, asset: native ? XLM : USDC }),
            makeRules({ amountRule: ar, memoRule: mr }),
          );
          expect(result.outcome === "VERIFIED").toBe(result.reasons.length === 0);
        },
      ),
    );
  });
});
