import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AmountError, fromStroops, MAX_STROOPS, toStroops } from "../../src/lib/amount.js";

describe("toStroops", () => {
  it.each([
    ["10", 100_000_000n],
    ["10.5", 105_000_000n],
    ["0.0000001", 1n],
    ["1.0000000", 10_000_000n],
    ["0", 0n],
    ["922337203685.4775807", MAX_STROOPS],
  ])("%s -> %s", (input, expected) => {
    expect(toStroops(input)).toBe(expected);
  });

  it.each([
    "",
    "abc",
    "1.",
    ".5",
    "-1",
    "+1",
    "1e3",
    "1,5",
    " 1",
    "1.00000001",
    "0x10",
    "1234567890123",
  ])("rejects %j", (input) => {
    expect(() => toStroops(input)).toThrow(AmountError);
  });

  it("rejects amounts above the int64 limit", () => {
    expect(() => toStroops("922337203685.4775808")).toThrow(AmountError);
  });

  it("keeps precision a float would lose", () => {
    expect(toStroops("0.1") + toStroops("0.2")).toBe(toStroops("0.3"));
    expect(toStroops("900719925474.0993001")).toBe(9_007_199_254_740_993_001n);
  });
});

describe("fromStroops", () => {
  it.each([
    [0n, "0.0000000"],
    [1n, "0.0000001"],
    [105_000_000n, "10.5000000"],
    [MAX_STROOPS, "922337203685.4775807"],
  ])("%s -> %s", (input, expected) => {
    expect(fromStroops(input)).toBe(expected);
  });

  it("rejects negative amounts", () => {
    expect(() => fromStroops(-1n)).toThrow(AmountError);
  });
});

describe("amount properties", () => {
  it("stroops -> string -> stroops round-trips for every valid amount", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: MAX_STROOPS }), (stroops) => {
        expect(toStroops(fromStroops(stroops))).toBe(stroops);
      }),
    );
  });

  it("string -> stroops -> string preserves the value", () => {
    const amount = fc
      .tuple(
        fc.bigInt({ min: 0n, max: 99_999_999_999n }),
        fc.integer({ min: 0, max: 9_999_999 }),
        fc.integer({ min: 1, max: 7 }),
      )
      .map(
        ([whole, fraction, digits]) =>
          `${whole}.${String(fraction).padStart(7, "0").slice(0, digits)}`,
      );
    fc.assert(
      fc.property(amount, (text) => {
        const [whole = "", fraction = ""] = text.split(".");
        expect(fromStroops(toStroops(text))).toBe(`${whole}.${fraction.padEnd(7, "0")}`);
      }),
    );
  });
});
