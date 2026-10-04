/** Circle's USDC issuer on Stellar Testnet. */
export const USDC_ISSUER =
  process.env.NEXT_PUBLIC_USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const USDC = { code: "USDC", issuer: USDC_ISSUER };
export const XLM = { code: "XLM", issuer: null };

/** Where the developer docs live. */
export const DOCS_URL = process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3100";
