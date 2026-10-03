// Creates a demo developer, endpoint and watches for local development, through the API.
//   pnpm --filter @webhook/scripts seed            (the API must be running)
import { Keypair } from "@stellar/stellar-sdk";
import { developerClient } from "./lib.js";

const EMAIL = "demo@example.com";
const PASSWORD = "demo webhook passphrase";
const USDC_ISSUER =
  process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const { api, key } = await developerClient(EMAIL, PASSWORD);
const { endpoint, secret } = await api.post<{
  endpoint: { id: string; url: string };
  secret: string;
}>("/v1/endpoints", {
  url: process.env.RECEIVER_URL ?? "http://localhost:4100/webhooks",
  description: "Local mock receiver",
});

const wallet = process.env.WALLET ?? Keypair.random().publicKey();
const watches = [
  {
    label: "Any USDC or XLM",
    assets: [
      { code: "USDC", issuer: USDC_ISSUER },
      { code: "XLM", issuer: null },
    ],
  },
  {
    label: "USDC checkout: at least 10, memo required",
    assets: [{ code: "USDC", issuer: USDC_ISSUER }],
    amountRule: { kind: "min", amount: "10" },
    memoRule: { kind: "present" },
    eventTypes: ["payment.received", "payment.rejected"],
  },
];
for (const watch of watches) {
  const created = await api.post<{ watch: { id: string }; warnings: string[] }>("/v1/watches", {
    walletAddress: wallet,
    endpointId: endpoint.id,
    ...watch,
  });
  console.log(
    `watch ${created.watch.id}: ${watch.label} ${created.warnings.length ? `(warnings: ${created.warnings.join(", ")})` : ""}`,
  );
}

console.log(`
Demo account ready
  email:          ${EMAIL}
  password:       ${PASSWORD}
  API key:        ${key}
  endpoint:       ${endpoint.url} (${endpoint.id})
  webhook secret: ${secret}
  watched wallet: ${wallet}

Start the receiver with:
  WEBHOOK_SECRET=${secret} pnpm --filter @webhook/scripts mock-receiver`);
