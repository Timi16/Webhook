import { Address, Asset, nativeToScVal, Networks, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildFilters, RpcEventSource } from "../../src/engine/sources/rpcEventSource.js";
import { randomAddress } from "../helpers/payments.js";

const transfer = xdr.ScVal.scvSymbol("transfer").toXDR("base64");
const mint = xdr.ScVal.scvSymbol("mint").toXDR("base64");

describe("buildFilters", () => {
  it("W3: filters by destination wallet and never by asset contract, so wrong assets are still seen", () => {
    const wallet = randomAddress();
    const to = new Address(wallet).toScVal().toXDR("base64");
    const filters = buildFilters([wallet]);
    expect(filters).toEqual([
      {
        type: "contract",
        topics: [
          [transfer, "*", to, "*"],
          [mint, to, "*"],
          [mint, "*", to, "*"],
        ],
      },
    ]);
    expect(filters.every((f) => f.contractIds === undefined)).toBe(true);
  });

  it("uses one filter per wallet up to the RPC limit of five", () => {
    expect(buildFilters(Array.from({ length: 5 }, randomAddress))).toHaveLength(5);
  });

  it("falls back to every transfer and mint when there are more wallets than fit (or none)", () => {
    const all = [
      {
        type: "contract",
        topics: [
          [transfer, "*", "*", "*"],
          [mint, "*", "*"],
          [mint, "*", "*", "*"],
        ],
      },
    ];
    expect(buildFilters(Array.from({ length: 6 }, randomAddress))).toEqual(all);
    expect(buildFilters([])).toEqual(all);
  });
});

describe("RpcEventSource.fetch", () => {
  const wallet = randomAddress();
  const event = (id: string, ledger: number) => ({
    id,
    type: "contract" as const,
    ledger,
    ledgerClosedAt: "2026-10-03T18:52:17Z",
    transactionIndex: 1,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: id.padEnd(64, "0"),
    contractId: { toString: () => Asset.native().contractId(Networks.TESTNET) },
    topic: [
      xdr.ScVal.scvSymbol("transfer"),
      new Address(randomAddress()).toScVal(),
      new Address(wallet).toScVal(),
      nativeToScVal("native", { type: "string" }),
    ],
    value: nativeToScVal(10_000_000n, { type: "i128" }),
  });

  function sourceReturning(events: ReturnType<typeof event>[], requests: unknown[]) {
    const server = {
      getLatestLedger: async () => ({ sequence: 500 }),
      getHealth: async () => ({ oldestLedger: 100 }),
      getEvents: async (request: unknown) => {
        requests.push(request);
        return { events, cursor: "next-token", latestLedger: 500, oldestLedger: 100 };
      },
    };
    return new RpcEventSource(server as never, Networks.TESTNET, () => [wallet]);
  }

  it("starts from a ledger, then pages with the returned cursor", async () => {
    const requests: Record<string, unknown>[] = [];
    const source = sourceReturning([event("a", 120)], requests);

    const first = await source.fetch({ ledger: 110 }, 200);
    expect(requests[0]).toMatchObject({ startLedger: 110, limit: 200 });
    expect(first.payments).toHaveLength(1);
    expect(first.payments[0]).toMatchObject({
      to: wallet,
      amountStroops: 10_000_000n,
      source: "rpc",
    });
    // Fewer events than the limit: everything up to the tip was scanned.
    expect(first).toMatchObject({ fetched: 1, next: { ledger: 500, pagingToken: "next-token" } });

    await source.fetch(first.next, 200);
    expect(requests[1]).toMatchObject({ cursor: "next-token" });
    expect(requests[1]).not.toHaveProperty("startLedger");
    expect(await source.oldestLedger()).toBe(100);
    expect(await source.latestLedger()).toBe(500);
  });

  it("reports the last event's ledger when the page is full", async () => {
    const source = sourceReturning([event("a", 120), event("b", 121)], []);
    const page = await source.fetch({ ledger: 110 }, 2);
    expect(page).toMatchObject({ fetched: 2, next: { ledger: 121 } });
  });
});
