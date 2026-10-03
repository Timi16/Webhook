import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../../src/lib/crypto.js";
import { signPayload, verifySignature } from "../../src/lib/hmac.js";
import { generateApiKey, generateWebhookSecret, sha256Hex } from "../../src/lib/ids.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const vector = JSON.parse(
  readFileSync(new URL("../fixtures/signature.json", import.meta.url), "utf8"),
) as { secret: string; timestamp: number; body: string; signature: string };

describe("endpoint secret encryption", () => {
  it("round-trips and uses a fresh IV every time", () => {
    const a = encryptSecret("whsec_abc", KEY);
    const b = encryptSecret("whsec_abc", KEY);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, KEY)).toBe("whsec_abc");
    expect(decryptSecret(b, KEY)).toBe("whsec_abc");
  });

  it("refuses tampered ciphertext and the wrong key", () => {
    const raw = Buffer.from(encryptSecret("whsec_abc", KEY), "base64");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 1;
    expect(() => decryptSecret(raw.toString("base64"), KEY)).toThrow();
    const otherKey = Buffer.alloc(32, 8).toString("base64");
    expect(() => decryptSecret(encryptSecret("whsec_abc", KEY), otherKey)).toThrow();
  });
});

describe("webhook signature", () => {
  it("matches the fixed test vector shared with the docs", () => {
    expect(signPayload(vector.secret, vector.timestamp, vector.body)).toBe(vector.signature);
  });

  it("verifies a single signature and either signature during a rotation", () => {
    const opts = { now: vector.timestamp + 10 };
    const ts = String(vector.timestamp);
    expect(verifySignature(vector.secret, `v1=${vector.signature}`, ts, vector.body, opts)).toBe(
      true,
    );
    const rotated = `v1=${"0".repeat(64)}, v1=${vector.signature}`;
    expect(verifySignature(vector.secret, rotated, ts, vector.body, opts)).toBe(true);
  });

  it("rejects a changed body, a wrong secret and a stale timestamp", () => {
    const ts = String(vector.timestamp);
    const header = `v1=${vector.signature}`;
    const opts = { now: vector.timestamp };
    expect(verifySignature(vector.secret, header, ts, vector.body + " ", opts)).toBe(false);
    expect(verifySignature("whsec_other", header, ts, vector.body, opts)).toBe(false);
    expect(
      verifySignature(vector.secret, header, ts, vector.body, { now: vector.timestamp + 301 }),
    ).toBe(false);
    expect(verifySignature(vector.secret, header, "abc", vector.body, opts)).toBe(false);
  });
});

describe("ids", () => {
  it("generates API keys with the whk_test_ prefix and stores only a hash", () => {
    const { key, prefix, keyHash } = generateApiKey();
    expect(key).toMatch(/^whk_test_[0-9A-Za-z]{43}$/);
    expect(prefix).toBe(key.slice(0, 13));
    expect(keyHash).toBe(sha256Hex(key));
    expect(generateApiKey().key).not.toBe(key);
  });

  it("generates whsec_ secrets from 32 random bytes", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});
