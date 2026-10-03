import {
  Account,
  Address,
  Asset,
  MuxedAccount,
  nativeToScVal,
  StrKey,
  Networks,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeEvent, type RpcEventLike } from "../../src/engine/decode.js";
import { randomAddress } from "../helpers/payments.js";

const PASSPHRASE = Networks.TESTNET;
const NATIVE_CONTRACT = Asset.native().contractId(PASSPHRASE);

// Event values captured from testnet during the Phase 1 spike.
const SPIKE = {
  plain: "AAAACgAAAAAAAAAAAAAAAACYloA=", // 1 XLM, no memo
  memoText:
    "AAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAABMS0AAAAADwAAAAt0b19tdXhlZF9pZAAAAAAOAAAABWhlbGxvAAAA",
  memoId:
    "AAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAABycOAAAAADwAAAAt0b19tdXhlZF9pZAAAAAAFAAAAAAAAAAc=",
  memoHash:
    "AAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAACYloAAAAADwAAAAt0b19tdXhlZF9pZAAAAAANAAAAIKurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6ur",
  muxedDest:
    "AAAAEQAAAAEAAAACAAAADwAAAAZhbW91bnQAAAAAAAoAAAAAAAAAAAAAAAAC+vCAAAAADwAAAAt0b19tdXhlZF9pZAAAAAAFAAAAAAAAACo=",
};

const symbol = (s: string) => xdr.ScVal.scvSymbol(s);
const address = (a: string) => new Address(a).toScVal();
const text = (s: string) => nativeToScVal(s, { type: "string" });
const i128 = (n: bigint) => nativeToScVal(n, { type: "i128" });
const fromSpike = (b64: string) => xdr.ScVal.fromXDR(b64, "base64");

const from = randomAddress();
const to = randomAddress();

function transferEvent(overrides: Partial<RpcEventLike> = {}): RpcEventLike {
  return {
    id: "0021500563334107136-0000000000",
    ledger: 5005990,
    ledgerClosedAt: "2026-10-03T18:52:17Z",
    txHash: "a5".repeat(32),
    inSuccessfulContractCall: true,
    contractId: NATIVE_CONTRACT,
    topic: [symbol("transfer"), address(from), address(to), text("native")],
    value: fromSpike(SPIKE.plain),
    ...overrides,
  };
}

describe("decodeEvent", () => {
  it("decodes a plain XLM payment", () => {
    expect(decodeEvent(transferEvent(), PASSPHRASE)).toEqual({
      eventId: "0021500563334107136-0000000000",
      txHash: "a5".repeat(32),
      ledger: 5005990,
      ledgerClosedAt: new Date("2026-10-03T18:52:17Z"),
      from,
      to,
      memo: null,
      memoType: "none",
      asset: { code: "XLM", issuer: null },
      amountStroops: 10_000_000n,
      eventType: "transfer",
      source: "rpc",
    });
  });

  it("W11: maps to_muxed_id by type - string to text, u64 to id (decimal), bytes to hash (hex)", () => {
    const decode = (value: string) =>
      decodeEvent(transferEvent({ value: fromSpike(value) }), PASSPHRASE);
    expect(decode(SPIKE.memoText)).toMatchObject({
      memo: "hello",
      memoType: "text",
      amountStroops: 20_000_000n,
    });
    expect(decode(SPIKE.memoId)).toMatchObject({
      memo: "7",
      memoType: "id",
      amountStroops: 30_000_000n,
    });
    expect(decode(SPIKE.memoHash)).toMatchObject({ memo: "ab".repeat(32), memoType: "hash" });
  });

  it("strips NUL from text memos, which Postgres cannot store and would wedge ingestion", () => {
    const value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: symbol("amount"), val: i128(5n) }),
      new xdr.ScMapEntry({ key: symbol("to_muxed_id"), val: text("a\u0000b\u0000") }),
    ]);
    expect(decodeEvent(transferEvent({ value }), PASSPHRASE)).toMatchObject({
      memo: "ab",
      memoType: "text",
    });
  });

  it("treats memo bytes that are not 32 long as a (non-UTF-8) text memo, never as a hash", () => {
    const value = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: symbol("amount"), val: i128(5n) }),
      new xdr.ScMapEntry({
        key: symbol("to_muxed_id"),
        val: xdr.ScVal.scvBytes(Buffer.from([0x68, 0x69, 0x00, 0xff])),
      }),
    ]);
    const payment = decodeEvent(transferEvent({ value }), PASSPHRASE);
    expect(payment?.memoType).toBe("text");
    expect(payment?.memo).toMatch(/^hi/);
    expect(payment?.memo).not.toContain("\u0000");
  });

  it("W10: M-address destination arrives on the base wallet with the mux ID as an ID memo", () => {
    const payment = decodeEvent(transferEvent({ value: fromSpike(SPIKE.muxedDest) }), PASSPHRASE);
    expect(payment).toMatchObject({ to, memo: "42", memoType: "id", amountStroops: 50_000_000n });
  });

  it("W10: strips a muxed destination or sender in the topics down to the base address", () => {
    const muxedTo = new MuxedAccount(new Account(to, "0"), "5").accountId();
    const muxedFrom = new MuxedAccount(new Account(from, "0"), "6").accountId();
    const payment = decodeEvent(
      transferEvent({
        topic: [symbol("transfer"), text(muxedFrom), text(muxedTo), text("native")],
      }),
      PASSPHRASE,
    );
    expect(payment).toMatchObject({ from, to, toMuxedId: "5" });
  });

  it("W10: decodes an issuer mint, with the issuer as the sender", () => {
    const issuer = randomAddress();
    const asset = new Asset("USDC", issuer);
    const payment = decodeEvent(
      transferEvent({
        contractId: asset.contractId(PASSPHRASE),
        topic: [symbol("mint"), address(to), text(`USDC:${issuer}`)],
        value: i128(80_000_000n),
      }),
      PASSPHRASE,
    );
    expect(payment).toMatchObject({
      eventType: "mint",
      from: issuer,
      to,
      asset: { code: "USDC", issuer },
      amountStroops: 80_000_000n,
    });
  });

  it("W10: decodes a transfer from a contract wallet (C address payer)", () => {
    const payment = decodeEvent(
      transferEvent({
        topic: [symbol("transfer"), address(NATIVE_CONTRACT), address(to), text("native")],
      }),
      PASSPHRASE,
    );
    expect(payment).toMatchObject({ from: NATIVE_CONTRACT, to });
  });

  it("drops a transfer event that names an asset but comes from a different contract", () => {
    const issuer = randomAddress();
    const spoofed = transferEvent({
      // Emitted by the native contract (or any attacker contract) while claiming to be USDC.
      topic: [symbol("transfer"), address(from), address(to), text(`USDC:${issuer}`)],
    });
    expect(decodeEvent(spoofed, PASSPHRASE)).toBeNull();
  });

  it("W10: decodes payments whose sender is a claimable balance or a liquidity pool", () => {
    const balance = StrKey.encodeClaimableBalance(
      Buffer.concat([Buffer.from([0]), Buffer.alloc(32, 9)]),
    );
    const pool = StrKey.encodeLiquidityPool(Buffer.alloc(32, 7));
    for (const sender of [balance, pool]) {
      const payment = decodeEvent(
        transferEvent({
          topic: [symbol("transfer"), address(sender), address(to), text("native")],
          operationIndex: 2,
        }),
        PASSPHRASE,
      );
      expect(payment).toMatchObject({
        from: sender,
        to,
        amountStroops: 10_000_000n,
        operationIndex: 2,
      });
    }
  });

  it("ignores a wallet paying itself, such as a path-payment swap", () => {
    const self = transferEvent({
      topic: [symbol("transfer"), address(to), address(to), text("native")],
    });
    expect(decodeEvent(self, PASSPHRASE)).toBeNull();
  });

  it("drops failed calls, unknown topics, non-positive amounts and contract destinations", () => {
    expect(decodeEvent(transferEvent({ inSuccessfulContractCall: false }), PASSPHRASE)).toBeNull();
    expect(decodeEvent(transferEvent({ contractId: undefined }), PASSPHRASE)).toBeNull();
    expect(
      decodeEvent(
        transferEvent({ topic: [symbol("burn"), address(from), text("native")] }),
        PASSPHRASE,
      ),
    ).toBeNull();
    expect(decodeEvent(transferEvent({ value: i128(0n) }), PASSPHRASE)).toBeNull();
    expect(decodeEvent(transferEvent({ value: i128(-5n) }), PASSPHRASE)).toBeNull();
    expect(decodeEvent(transferEvent({ value: i128(2n ** 63n) }), PASSPHRASE)).toBeNull();
    expect(decodeEvent(transferEvent({ value: text("nope") }), PASSPHRASE)).toBeNull();
    expect(
      decodeEvent(
        transferEvent({
          topic: [symbol("transfer"), address(from), address(NATIVE_CONTRACT), text("native")],
        }),
        PASSPHRASE,
      ),
    ).toBeNull();
    expect(decodeEvent(transferEvent({ ledgerClosedAt: "not a date" }), PASSPHRASE)).toBeNull();
  });
});
