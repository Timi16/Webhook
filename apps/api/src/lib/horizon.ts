import type { Asset } from "@webhook/shared";
import { z } from "zod";
import { XLM } from "./stellar.js";

export interface AccountInfo {
  exists: boolean;
  /** Assets the account can hold: XLM plus one per trustline. */
  assets: Asset[];
}

/** The small part of Horizon the API needs. `null` means Horizon could not be reached. */
export interface HorizonClient {
  account(address: string): Promise<AccountInfo | null>;
  latestLedger(): Promise<number | null>;
}

const accountSchema = z.object({
  balances: z.array(
    z.object({
      asset_type: z.string(),
      asset_code: z.string().optional(),
      asset_issuer: z.string().optional(),
    }),
  ),
});
const rootSchema = z.object({ history_latest_ledger: z.number().int() });

export function createHorizonClient(
  horizonUrl: string,
  fetchImpl: typeof fetch = fetch,
): HorizonClient {
  const get = (path: string) =>
    fetchImpl(new URL(path, horizonUrl), { signal: AbortSignal.timeout(8_000) });
  return {
    async account(address) {
      try {
        const res = await get(`/accounts/${address}`);
        if (res.status === 404) return { exists: false, assets: [] };
        if (!res.ok) return null;
        const { balances } = accountSchema.parse(await res.json());
        const assets: Asset[] = [XLM];
        for (const b of balances) {
          if (b.asset_code && b.asset_issuer)
            assets.push({ code: b.asset_code, issuer: b.asset_issuer });
        }
        return { exists: true, assets };
      } catch {
        return null;
      }
    },
    async latestLedger() {
      try {
        const res = await get("/");
        if (!res.ok) return null;
        return rootSchema.parse(await res.json()).history_latest_ledger;
      } catch {
        return null;
      }
    },
  };
}
