import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ENV_KEYS, EnvError, parseEnv } from "../../src/config/env.js";
import { rawTestEnv } from "../helpers/testEnv.js";

describe("parseEnv", () => {
  it("accepts a complete testnet configuration", () => {
    const env = parseEnv(rawTestEnv());
    expect(env.PORT).toBe(4000);
    expect(env.RESEND_API_KEY).toBeUndefined();
  });

  it("treats empty optional variables as unset", () => {
    const env = parseEnv(rawTestEnv({ RESEND_API_KEY: "", ALERT_TELEGRAM_CHAT_ID: "" }));
    expect(env.RESEND_API_KEY).toBeUndefined();
    expect(env.ALERT_TELEGRAM_CHAT_ID).toBeUndefined();
  });

  it("refuses to boot on a non-testnet passphrase", () => {
    const raw = rawTestEnv({
      NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
    });
    expect(() => parseEnv(raw)).toThrow(/NETWORK_PASSPHRASE: must be the Stellar testnet/);
  });

  it("names every missing variable", () => {
    const raw = rawTestEnv({ DATABASE_URL: undefined, SESSION_SECRET: undefined });
    expect(() => parseEnv(raw)).toThrow(
      /DATABASE_URL: is required[\s\S]*SESSION_SECRET: is required/,
    );
  });

  it("requires ENCRYPTION_KEY to decode to exactly 32 bytes", () => {
    const raw = rawTestEnv({ ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") });
    expect(() => parseEnv(raw)).toThrow(/ENCRYPTION_KEY: must be exactly 32 bytes/);
  });

  it("requires DASHBOARD_ORIGIN to be a bare origin", () => {
    const raw = rawTestEnv({ DASHBOARD_ORIGIN: "http://localhost:3000/" });
    expect(() => parseEnv(raw)).toThrow(/DASHBOARD_ORIGIN/);
  });

  it("never echoes secret values in the error", () => {
    const secret = "not-hex-super-secret-value";
    try {
      parseEnv(rawTestEnv({ SESSION_SECRET: secret, ENCRYPTION_KEY: secret }));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(EnvError);
      expect((err as EnvError).message).not.toContain(secret);
    }
  });
});

describe(".env.example", () => {
  it("lists every variable read in env.ts", () => {
    const example = readFileSync(new URL("../../.env.example", import.meta.url), "utf8");
    const listed = new Set(
      example
        .split("\n")
        .map((line) => /^([A-Z0-9_]+)=/.exec(line)?.[1])
        .filter((name) => name !== undefined),
    );
    expect(ENV_KEYS.filter((key) => !listed.has(key))).toEqual([]);
  });
});
