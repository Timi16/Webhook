import {
  Account,
  Address,
  Asset,
  Memo,
  MuxedAccount,
  nativeToScVal,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildFilters, RpcEventSource } from "../../src/engine/sources/rpcEventSource.js";
import { makePayment, randomAddress } from "../helpers/payments.js";

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

describe("RpcEventSource.resolve", () => {
  const wallet = randomAddress();
  const muxedWallet = new MuxedAccount(new Account(wallet, "0"), "777").accountId();

  function envelope(destination: string, memo?: Memo) {
    const builder = new TransactionBuilder(new Account(randomAddress(), "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({ destination: randomAddress(), asset: Asset.native(), amount: "1" }),
      )
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "5" }));
    if (memo) builder.addMemo(memo);
    return builder.setTimeout(0).build().toEnvelope();
  }

  function sourceWith(transactions: Record<string, ReturnType<typeof envelope>>) {
    const calls: string[] = [];
    const server = {
      getTransaction: async (hash: string) => {
        calls.push(hash);
        const envelopeXdr = transactions[hash];
        return envelopeXdr ? { status: "SUCCESS", envelopeXdr } : { status: "NOT_FOUND" };
      },
    };
    return { source: new RpcEventSource(server as never, Networks.TESTNET, () => [wallet]), calls };
  }

  // What the decoder produces for any u64 to_muxed_id: an ID memo, ambiguous until resolved.
  const ambiguous = (txHash: string, id: string) =>
    makePayment({ to: wallet, txHash, memo: id, memoType: "id", operationIndex: 1 });

  it("W10: a payment to an M-address gets toMuxedId and its real memo back", async () => {
    const { source } = sourceWith({
      aa: envelope(muxedWallet, Memo.text("order-9")),
      bb: envelope(muxedWallet, Memo.hash("cd".repeat(32))),
    });
    const [text, hash] = await source.resolve([ambiguous("aa", "777"), ambiguous("bb", "777")]);
    expect(text).toMatchObject({ toMuxedId: "777", memo: "order-9", memoType: "text" });
    expect(hash).toMatchObject({ toMuxedId: "777", memo: "cd".repeat(32), memoType: "hash" });
  });

  it("W10: an M-address payment without a memo keeps the mux ID as its ID memo", async () => {
    const { source } = sourceWith({ aa: envelope(muxedWallet) });
    const [payment] = await source.resolve([ambiguous("aa", "777")]);
    expect(payment).toMatchObject({ toMuxedId: "777", memo: "777", memoType: "id" });
  });

  it("W11: a genuine ID memo to a plain address is left alone, with no mux ID", async () => {
    const { source } = sourceWith({ aa: envelope(wallet, Memo.id("424242")) });
    const [payment] = await source.resolve([ambiguous("aa", "424242")]);
    expect(payment).toMatchObject({ memo: "424242", memoType: "id" });
    expect(payment!.toMuxedId).toBeUndefined();
  });

  it("only looks up u64 memos, once per transaction, and tolerates a transaction RPC no longer has", async () => {
    const { source, calls } = sourceWith({ aa: envelope(muxedWallet, Memo.text("x")) });
    const plain = makePayment({
      to: wallet,
      txHash: "zz",
      memo: "hello",
      memoType: "text",
      operationIndex: 1,
    });
    const none = makePayment({ to: wallet, txHash: "yy", operationIndex: 1 });
    const gone = ambiguous("missing", "5");
    const resolved = await source.resolve([
      plain,
      none,
      ambiguous("aa", "777"),
      ambiguous("aa", "777"),
      gone,
    ]);
    expect(resolved[0]).toBe(plain);
    expect(resolved[1]).toBe(none);
    expect(resolved[4]).toBe(gone);
    expect(calls).toEqual(["aa", "missing"]);
  });
});
