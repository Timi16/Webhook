import { Address, xdr, type rpc } from "@stellar/stellar-sdk";
import { decodeEvent } from "../decode.js";
import type { EventCursor, FetchResult, NormalizedPayment, StellarSource } from "../types.js";

// RPC limits: at most 5 filters per request and 5 topic filters per filter.
const MAX_FILTERS = 5;
const OLDEST_LEDGER_TTL_MS = 30_000;

const symbol = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");
const TRANSFER = symbol("transfer");
const MINT = symbol("mint");

// transfer: [sym, from, to, asset] · mint: [sym, to, asset] (CAP-67) or [sym, admin, to, asset] (older)
const ALL_PAYMENTS: rpc.Api.EventFilter[] = [
  {
    type: "contract",
    topics: [
      [TRANSFER, "*", "*", "*"],
      [MINT, "*", "*"],
      [MINT, "*", "*", "*"],
    ],
  },
];

/**
 * Filters by destination wallet, never by asset contract: a payment in the wrong asset or from
 * a counterfeit issuer must still be seen so it can be recorded as REJECTED. With more wallets
 * than fit in one request, every transfer and mint is fetched and filtered in memory instead.
 */
export function buildFilters(wallets: string[]): rpc.Api.EventFilter[] {
  if (wallets.length === 0 || wallets.length > MAX_FILTERS) return ALL_PAYMENTS;
  return wallets.map((wallet) => {
    const to = new Address(wallet).toScVal().toXDR("base64");
    return {
      type: "contract",
      topics: [
        [TRANSFER, "*", to, "*"],
        [MINT, to, "*"],
        [MINT, "*", to, "*"],
      ],
    };
  });
}

type RpcClient = Pick<rpc.Server, "getEvents" | "getHealth" | "getLatestLedger">;

export class RpcEventSource implements StellarSource {
  private oldest: { ledger: number; at: number } | undefined;

  constructor(
    private readonly server: RpcClient,
    private readonly networkPassphrase: string,
    private readonly watchedWallets: () => string[],
  ) {}

  async latestLedger(): Promise<number> {
    return (await this.server.getLatestLedger()).sequence;
  }

  async oldestLedger(): Promise<number> {
    if (!this.oldest || Date.now() - this.oldest.at > OLDEST_LEDGER_TTL_MS) {
      this.oldest = { ledger: (await this.server.getHealth()).oldestLedger, at: Date.now() };
    }
    return this.oldest.ledger;
  }

  async fetch(from: EventCursor, limit: number): Promise<FetchResult> {
    const filters = buildFilters(this.watchedWallets());
    const res = await this.server.getEvents(
      from.pagingToken
        ? { cursor: from.pagingToken, filters, limit }
        : { startLedger: from.ledger, filters, limit },
    );
    this.oldest = { ledger: res.oldestLedger, at: Date.now() };

    const payments: NormalizedPayment[] = [];
    for (const event of res.events) {
      const payment = decodeEvent(event, this.networkPassphrase);
      if (payment) payments.push(payment);
    }

    // A full page means more events are waiting; otherwise everything up to the tip was scanned.
    const last = res.events.at(-1);
    const ledger = res.events.length >= limit && last ? last.ledger : res.latestLedger;
    return { payments, next: { ledger, pagingToken: res.cursor }, fetched: res.events.length };
  }
}
