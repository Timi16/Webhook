// Writes openapi.json for the docs site: pnpm --filter @webhook/api openapi
import { writeFileSync } from "node:fs";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { buildApp } from "../app.js";
import { parseEnv, TESTNET_PASSPHRASE } from "../config/env.js";
import { createPrismaClient } from "../db/prisma.js";
import { createLogger } from "../lib/logger.js";
import { generateOpenApiDocument } from "./registry.js";

// The spec only depends on the route declarations, so placeholder config is enough; nothing connects.
const env = parseEnv({
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
  USDC_ISSUER: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  DASHBOARD_ORIGIN: "http://localhost:3000",
  SESSION_SECRET: "0".repeat(64),
  ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
  LOG_LEVEL: "silent",
});

const app = buildApp({
  env,
  logger: createLogger(env),
  prisma: createPrismaClient(env.DATABASE_URL),
});
// API_PUBLIC_URL is the address developers call, shown in every code sample.
const document = generateOpenApiDocument(
  app.locals.registry as OpenAPIRegistry,
  process.env.API_PUBLIC_URL,
);
const out = process.argv[2] ?? "openapi.json";
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`Wrote ${Object.keys(document.paths ?? {}).length} paths to ${out}`);
process.exit(0);
