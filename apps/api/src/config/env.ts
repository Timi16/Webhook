import { z } from "zod";

export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

// Empty strings in .env files mean "not set" for optional variables.
const optionalString = z.preprocess((v) => (v === "" ? undefined : v), z.string().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  // The address to listen on. In production the API sits behind a reverse proxy on the same
  // machine, so the default there is loopback: nobody can reach it without going through the proxy.
  HOST: optionalString,
  // How many reverse proxies sit in front of the API. Their X-Forwarded-For is trusted for the
  // client IP (rate limits, API key IP rules, logs). 0 = nobody is trusted: use the socket address.
  // Default: 1 in production, 0 otherwise. Set it to 0 if the API is exposed directly.
  TRUST_PROXY: z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.coerce.number().int().min(0).max(5).optional(),
  ),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgresql:// URL"),
  STELLAR_RPC_URL: z.url(),
  HORIZON_URL: z.url(),
  NETWORK_PASSPHRASE: z.literal(TESTNET_PASSPHRASE, {
    error: "must be the Stellar testnet passphrase; this service is testnet only",
  }),
  // Shape check only; full StrKey checksum validation arrives with @stellar/stellar-sdk in Phase 1.
  USDC_ISSUER: z.string().regex(/^G[A-Z2-7]{55}$/, "must be a Stellar public key (G...)"),
  DASHBOARD_ORIGIN: z.url().refine((v) => URL.canParse(v) && new URL(v).origin === v, {
    error: "must be a bare origin such as https://webhook.example.com (no path or trailing slash)",
  }),
  SESSION_SECRET: z.string().regex(/^[0-9a-fA-F]{64,}$/, "must be at least 64 hex characters"),
  ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, "base64").length === 32, {
    error: "must be exactly 32 bytes, base64-encoded",
  }),
  RESEND_API_KEY: optionalString,
  ALERT_TELEGRAM_BOT_TOKEN: optionalString,
  ALERT_TELEGRAM_CHAT_ID: optionalString,
  EMAIL_FROM: z.string().min(3).default("Webhook <onboarding@resend.dev>"),
  // Local development only: lets endpoints use http, any port and private IPs (e.g. the mock receiver).
  ALLOW_INSECURE_WEBHOOK_TARGETS: z.enum(["true", "false"]).default("false"),
  // Webhooks being sent at the same time, overall. Per developer (10) and per endpoint (5) are fixed.
  MAX_CONCURRENT_DELIVERIES: z.coerce.number().int().min(1).max(200).default(50),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

const checkedEnvSchema = envSchema.refine(
  (env) => !(env.NODE_ENV === "production" && env.ALLOW_INSECURE_WEBHOOK_TARGETS === "true"),
  { error: "must not be enabled in production", path: ["ALLOW_INSECURE_WEBHOOK_TARGETS"] },
);

export type Env = z.infer<typeof envSchema>;

export const ENV_KEYS = Object.keys(envSchema.shape);

export class EnvError extends Error {}

/** Parses raw env. The error names the bad variables but never echoes their values. */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = checkedEnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const name = issue.path.join(".");
      const reason = raw[name] === undefined ? "is required" : issue.message;
      return `  ${name}: ${reason}`;
    });
    throw new EnvError(`Invalid environment configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Refuses to boot on bad config, before anything connects. */
export function loadEnv(): Env {
  try {
    return parseEnv(process.env);
  } catch (err) {
    console.error(err instanceof EnvError ? err.message : err);
    process.exit(1);
  }
}
