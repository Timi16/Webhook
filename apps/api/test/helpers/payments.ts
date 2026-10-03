import { Keypair } from "@stellar/stellar-sdk";
import type { NormalizedPayment } from "../../src/engine/types.js";
import type { ParsedWatch } from "../../src/engine/watch.js";

export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = { code: "USDC", issuer: USDC_ISSUER };
export const XLM = { code: "XLM", issuer: null };

export function randomAddress(): string {
  return Keypair.random().publicKey();
}

let sequence = 0;

export function makePayment(overrides: Partial<NormalizedPayment> = {}): NormalizedPayment {
  sequence += 1;
  return {
    eventId: `${String(21500000000000000n + BigInt(sequence)).padStart(19, "0")}-0000000000`,
    txHash: sequence.toString(16).padStart(64, "0"),
    ledger: 1000,
    ledgerClosedAt: new Date("2026-10-03T12:00:00Z"),
    from: randomAddress(),
    to: randomAddress(),
    memo: null,
    memoType: "none",
    asset: USDC,
    amountStroops: 100_000_000n,
    eventType: "transfer",
    source: "rpc",
    ...overrides,
  };
}

export function makeRules(
  overrides: Partial<Pick<ParsedWatch, "assets" | "amountRule" | "memoRule" | "senderAllowlist">> = {},
): Pick<ParsedWatch, "assets" | "amountRule" | "memoRule" | "senderAllowlist"> {
  return {
    assets: [USDC],
    amountRule: { kind: "any" },
    memoRule: { kind: "any" },
    senderAllowlist: [],
    ...overrides,
  };
}
