import { xdr, type rpc } from "@stellar/stellar-sdk";
import type { Asset } from "@webhook/shared";
import { assetContractId } from "../../lib/stellar.js";
import { decodeEvent } from "../decode.js";
import type { EventCursor, FetchResult, NormalizedPayment, StellarSource } from "../types.js";

// RPC limits: at most 5 filters per request and 5 contract IDs per filter.
const MAX_FILTERS = 5;
const MAX_CONTRACTS_PER_FILTER = 5;
const OLDEST_LEDGER_TTL_MS = 30_000;

const symbol = (name: string) => xdr.ScVal.scvSymbol(name).toXDR("base64");

// transfer: [sym, from, to, asset] · mint: [sym, to, asset] (CAP-67) or [sym, admin, to, asset] (older)
const TOPICS = [
  [symbol("transfer"), "*", "*", "*"],
  [symbol("mint"), "*", "*"],
  [symbol("mint"), "*", "*", "*"],
];

/** Filter by the watched assets' contract IDs; if they don't fit, keep only the topic filter. */
export function buildFilters(assets: Asset[], networkPassphrase: string): rpc.Api.EventFilter[] {
  const contractIds = assets.map((asset) => assetContractId(asset, networkPassphrase));
  if (contractIds.length === 0 || contractIds.length > MAX_FILTERS * MAX_CONTRACTS_PER_FILTER) {
    return [{ type: "contract", topics: TOPICS }];
  }
  const filters: rpc.Api.EventFilter[] = [];
  for (let i = 0; i < contractIds.length; i += MAX_CONTRACTS_PER_FILTER) {
    filters.push({
      type: "contract",
      contractIds: contractIds.slice(i, i + MAX_CONTRACTS_PER_FILTER),
      topics: TOPICS,
    });
  }
  return filters;
}

type RpcClient = Pick<rpc.Server, "getEvents" | "getHealth" | "getLatestLedger">;

export class RpcEventSource implements StellarSource {
  private oldest: { ledger: number; at: number } | undefined;

  constructor(
    private readonly server: RpcClient,
    private readonly networkPassphrase: string,
    private readonly watchedAssets: () => Asset[],
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
    const filters = buildFilters(this.watchedAssets(), this.networkPassphrase);
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
