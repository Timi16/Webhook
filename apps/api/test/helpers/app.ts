import { Writable } from "node:stream";
import type { Express } from "express";
import { pino } from "pino";
import request from "supertest";
import { buildApp, type AppDeps } from "../../src/app.js";
import type { AccountInfo, HorizonClient } from "../../src/lib/horizon.js";
import { REDACT_PATHS } from "../../src/lib/logger.js";
import type { Mail, Mailer } from "../../src/lib/mailer.js";
import type { TestDb } from "./db.js";
import { testEnv } from "./testEnv.js";

export const ORIGIN = "http://localhost:3000";
export const PASSWORD = "correct horse battery";

export interface TestApp {
  app: Express;
  mails: Mail[];
  /** Everything the app logged, as one string. */
  logs: () => string;
  horizon: { accounts: Map<string, AccountInfo | null>; ledger: number | null };
  signup: (email?: string) => Promise<TestSession>;
}

export interface TestSession {
  developerId: string;
  email: string;
  cookie: string;
  /** Creates an API key and returns the full key. */
  createApiKey: () => Promise<{ id: string; key: string }>;
}

let counter = 0;

/** The real app with fast auth, generous rate limits, a fake Horizon and an in-memory mailbox. */
export function makeTestApp(db: TestDb, overrides: Partial<AppDeps> = {}): TestApp {
  const env = testEnv();
  const mails: Mail[] = [];
  const mailer: Mailer = { send: async (mail) => void mails.push(mail) };
  const chunks: string[] = [];
  const logger = pino(
    { level: "info", redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    }),
  );
  const horizonState = {
    accounts: new Map<string, AccountInfo | null>(),
    ledger: 5000 as number | null,
  };
  const horizon: HorizonClient = {
    account: async (address) =>
      horizonState.accounts.has(address)
        ? (horizonState.accounts.get(address) ?? null)
        : { exists: false, assets: [] },
    latestLedger: async () => horizonState.ledger,
  };

  const app = buildApp({
    env,
    logger,
    prisma: db.prisma,
    mailer,
    horizon,
    loginDelayMs: 0,
    testWaitMs: 3_000,
    rateLimits: { global: 100_000, auth: 100_000, api: 100_000 },
    quotas: { endpoints: 1_000, watches: 1_000, apiKeys: 1_000 },
    // Hostnames resolve to a public address unless they say otherwise.
    urlPolicy: {
      lookup: async (host) => [
        { address: host.includes("internal") ? "10.0.0.5" : "93.184.216.34", family: 4 },
      ],
    },
    ...overrides,
  });

  async function signup(email = `dev${++counter}-${Date.now()}@example.com`): Promise<TestSession> {
    const res = await request(app)
      .post("/auth/signup")
      .set("Origin", ORIGIN)
      .send({ email, password: PASSWORD });
    if (res.status !== 201)
      throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    return {
      developerId: res.body.developer.id as string,
      email,
      cookie,
      async createApiKey() {
        const created = await request(app)
          .post("/v1/api-keys")
          .set("Cookie", cookie)
          .set("Origin", ORIGIN)
          .send({ name: "test key" });
        return { id: created.body.apiKey.id as string, key: created.body.key as string };
      },
    };
  }

  return { app, mails, logs: () => chunks.join(""), horizon: horizonState, signup };
}
