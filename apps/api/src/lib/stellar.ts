import { Asset as StellarAsset, MuxedAccount, StrKey } from "@stellar/stellar-sdk";
import type { Asset } from "@webhook/shared";

export const XLM: Asset = { code: "XLM", issuer: null };

export function assetKey(asset: Asset): string {
  return asset.issuer === null ? "native" : `${asset.code}:${asset.issuer}`;
}

/** M-address -> its base G address. Anything else is returned unchanged. */
export function toBaseAddress(address: string): { base: string; muxedId?: string } {
  if (address.startsWith("M") && StrKey.isValidMed25519PublicKey(address)) {
    const muxed = MuxedAccount.fromAddress(address, "0");
    return { base: muxed.baseAccount().accountId(), muxedId: muxed.id() };
  }
  return { base: address };
}

/** SEP-11 asset string as used in CAP-67 event topics: "native" or "CODE:ISSUER". */
export function parseSep11Asset(value: string): Asset | null {
  if (value === "native") return XLM;
  const [code, issuer, ...rest] = value.split(":");
  if (!code || !issuer || rest.length > 0) return null;
  if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !StrKey.isValidEd25519PublicKey(issuer)) return null;
  return { code, issuer };
}

const contractIdCache = new Map<string, string>();

/** The Stellar Asset Contract ID for an asset on the given network. */
export function assetContractId(asset: Asset, networkPassphrase: string): string {
  const cacheKey = `${networkPassphrase}|${assetKey(asset)}`;
  let id = contractIdCache.get(cacheKey);
  if (id === undefined) {
    const stellarAsset =
      asset.issuer === null ? StellarAsset.native() : new StellarAsset(asset.code, asset.issuer);
    id = stellarAsset.contractId(networkPassphrase);
    // Anyone can emit events naming made-up assets, so the cache is bounded.
    if (contractIdCache.size >= 5_000) contractIdCache.clear();
    contractIdCache.set(cacheKey, id);
  }
  return id;
}
