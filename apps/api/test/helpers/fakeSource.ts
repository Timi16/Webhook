import { HorizonBackfillSource } from "../../src/engine/sources/horizonBackfill.js";
import type {
  EventCursor,
  FetchResult,
  NormalizedPayment,
  StellarSource,
} from "../../src/engine/types.js";

/** In-memory StellarSource. The paging token is simply the index of the next payment. */
export class FakeSource implements StellarSource {
  payments: NormalizedPayment[] = [];
  tip = 1000;
  oldest = 1;
  failNextFetch = false;

  async latestLedger(): Promise<number> {
    return this.tip;
  }

  async oldestLedger(): Promise<number> {
    return this.oldest;
  }

  async fetch(from: EventCursor, limit: number): Promise<FetchResult> {
    if (this.failNextFetch) {
      this.failNextFetch = false;
      throw new Error("RPC unreachable");
    }
    const sorted = [...this.payments].sort((a, b) => a.ledger - b.ledger);
    let start: number;
    if (from.pagingToken !== undefined) {
      start = parseInt(from.pagingToken, 10);
    } else {
      const index = sorted.findIndex((p) => p.ledger >= from.ledger);
      start = index === -1 ? sorted.length : index;
    }
    const page = sorted.slice(start, start + limit);
    const last = page.at(-1);
    return {
      payments: page,
      next: {
        ledger: page.length >= limit && last ? last.ledger : this.tip,
        pagingToken: String(start + page.length),
      },
      fetched: page.length,
    };
  }
}

/** A Horizon backfill source backed by canned records per wallet. */
export function fakeBackfill(
  recordsByWallet: Record<string, unknown[]> = {},
): HorizonBackfillSource {
  const fetchImpl = (async (input: URL | string | Request) => {
    const url = new URL(input.toString());
    const wallet = url.pathname.split("/")[2] ?? "";
    const cursor = BigInt(url.searchParams.get("cursor") ?? "0");
    const records = (recordsByWallet[wallet] ?? []).filter(
      (r) => BigInt((r as { paging_token: string }).paging_token) > cursor,
    );
    return new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });
  }) as typeof fetch;
  return new HorizonBackfillSource("https://horizon.invalid", fetchImpl);
}
