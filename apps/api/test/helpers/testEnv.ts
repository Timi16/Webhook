import { parseEnv, TESTNET_PASSPHRASE, type Env } from "../../src/config/env.js";

export function rawTestEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    NODE_ENV: "test",
    PORT: "4000",
    DATABASE_URL: "postgresql://webhook:webhook@localhost:5433/webhooks",
    STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    DASHBOARD_ORIGIN: "http://localhost:3000",
    SESSION_SECRET: "ab".repeat(32),
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    LOG_LEVEL: "silent",
    TRUST_PROXY: "1", // tests set X-Forwarded-For to play different clients
    ...overrides,
  };
}

export function testEnv(overrides: Record<string, string | undefined> = {}): Env {
  return parseEnv(rawTestEnv(overrides));
}
