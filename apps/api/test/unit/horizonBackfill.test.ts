import { describe, expect, it } from "vitest";
import {
  HorizonBackfillSource,
  mapHorizonRecord,
} from "../../src/engine/sources/horizonBackfill.js";
import { randomAddress, USDC } from "../helpers/payments.js";

const wallet = randomAddress();
const toid = (ledger: number, op: number) =>
  ((BigInt(ledger) << 32n) | BigInt(4096 + op)).toString();

// Shapes taken from real testnet records (3 Oct 2026).
function claimRecord(ledger: number) {
  const id = toid(ledger, 1);
  return {
    id,
    paging_token: id,
    transaction_successful: true,
    source_account: wallet,
    type: "claim_claimable_balance",
    created_at: "2026-10-03T20:41:17Z",
    transaction_hash: "afe052cee2d66dae5ba90e3010655a8e4ebcc5fe1db3352aa42e45036e6240d4",
    balance_id: "00000000cc989ab4a2118d5c4791fe69d3a5c177eb0cc6d3eb4be1dcdddbf0e0c5282958",
    claimant: wallet,
    transaction: { ledger, memo: "claim-1014", memo_type: "text" },
  };
}

function mergeRecord(ledger: number, from: string) {
  const id = toid(ledger, 2);
  return {
    id,
    paging_token: id,
    transaction_successful: true,
    type: "account_merge",
    created_at: "2026-10-03T20:45:00Z",
    transaction_hash: "bb".repeat(32),
    account: from,
    into: wallet,
    transaction: { ledger, memo_type: "none" },
  };
}

describe("mapHorizonRecord", () => {
  it("W10: maps a claimed claimable balance, with the balance's B address as the sender", () => {
    const payments = mapHorizonRecord(claimRecord(5007298), wallet, [
      { amount: "20.0000000", asset: USDC },
    ]);
    expect(payments).toEqual([
      {
        eventId: `hz-${toid(5007298, 1)}`,
        txHash: "afe052cee2d66dae5ba90e3010655a8e4ebcc5fe1db3352aa42e45036e6240d4",
        ledger: 5007298,
        ledgerClosedAt: new Date("2026-10-03T20:41:17Z"),
        // The same sender the live RPC event reported for this exact claim.
        from: "BAAMZGE2WSRBDDK4I6I742OTUXAXP2YMY3J6WS7B3TO5X4HAYUUCSWCVDU",
        to: wallet,
        memo: "claim-1014",
        memoType: "text",
        asset: USDC,
        amountStroops: 200_000_000n,
        eventType: "transfer",
        source: "horizon",
      },
    ]);
  });

  it("maps an account merge into the wallet using the credited amount", () => {
    const from = randomAddress();
    const [payment] = mapHorizonRecord(mergeRecord(100, from), wallet, [
      { amount: "9999.9999900", asset: { code: "XLM", issuer: null } },
    ]);
    expect(payment).toMatchObject({
      from,
      to: wallet,
      amountStroops: 99_999_999_900n,
      asset: { code: "XLM", issuer: null },
      memoType: "none",
    });
  });

  it("records nothing for a claim or merge without a credit, or one made by someone else", () => {
    expect(mapHorizonRecord(claimRecord(5), wallet, [])).toEqual([]);
    expect(
      mapHorizonRecord({ ...claimRecord(5), claimant: randomAddress() }, wallet, [
        { amount: "1", asset: USDC },
      ]),
    ).toEqual([]);
    expect(
      mapHorizonRecord({ ...claimRecord(5), balance_id: "nonsense" }, wallet, [
        { amount: "1", asset: USDC },
      ]),
    ).toEqual([]);
  });
});

describe("HorizonBackfillSource", () => {
  function sourceWith(routes: Record<string, unknown[]>, requests: string[] = []) {
    const fetchImpl = (async (input: URL | string | Request) => {
      const url = new URL(input.toString());
      requests.push(url.pathname);
      if (url.pathname.startsWith("/transactions/")) {
        return url.pathname.endsWith("/known")
          ? new Response(JSON.stringify({ envelope_xdr: "AAAA" }), { status: 200 })
          : new Response("{}", { status: 404 });
      }
      const cursor = BigInt(url.searchParams.get("cursor") ?? "0");
      const records = (routes[url.pathname] ?? []).filter(
        (r) =>
          !("paging_token" in (r as object)) ||
          BigInt((r as { paging_token: string }).paging_token) > cursor,
      );
      return new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });
    }) as typeof fetch;
    return new HorizonBackfillSource("https://horizon.invalid", fetchImpl);
  }

  it("recovers claims from the operations feed and merges from the payments feed, each once", async () => {
    const merger = randomAddress();
    const claim = claimRecord(120);
    const merge = mergeRecord(130, merger);
    const requests: string[] = [];
    const source = sourceWith(
      {
        [`/accounts/${wallet}/payments`]: [merge],
        // The operations feed repeats everything; only the claim may be taken from it.
        [`/accounts/${wallet}/operations`]: [
          claim,
          merge,
          { ...claimRecord(999), id: toid(999, 1), paging_token: toid(999, 1) },
        ],
        [`/operations/${claim.id}/effects`]: [
          {
            type: "claimable_balance_claimed",
            account: wallet,
            amount: "20.0000000",
            asset: `USDC:${USDC.issuer}`,
          },
          {
            type: "account_credited",
            account: wallet,
            amount: "20.0000000",
            asset_type: "credit_alphanum4",
            asset_code: USDC.code,
            asset_issuer: USDC.issuer,
          },
        ],
        [`/operations/${merge.id}/effects`]: [
          { type: "account_debited", account: merger, amount: "50.0000000", asset_type: "native" },
          { type: "account_credited", account: wallet, amount: "50.0000000", asset_type: "native" },
        ],
      },
      requests,
    );

    const payments = [];
    for await (const page of source.paymentsForWallet(wallet, 100, 500)) payments.push(...page);

    expect(
      payments.map((p) => [p.ledger, p.from.slice(0, 1), p.asset.code, p.amountStroops]),
    ).toEqual([
      [130, "G", "XLM", 500_000_000n],
      [120, "B", "USDC", 200_000_000n],
    ]);
    // The claim at ledger 999 is outside the range: its effects are never even requested.
    expect(requests.filter((r) => r.includes("/effects"))).toHaveLength(2);
  });

  it("returns a transaction envelope, or null when Horizon does not know the transaction", async () => {
    const source = sourceWith({});
    expect(await source.transactionEnvelope("known")).toBe("AAAA");
    expect(await source.transactionEnvelope("unknown")).toBeNull();
  });
});
