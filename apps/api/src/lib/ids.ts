import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";

export const API_KEY_PREFIX = "whk_test_";
export const WEBHOOK_SECRET_PREFIX = "whsec_";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function base62(bytes: Buffer): string {
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (value > 0n) {
    out = BASE62.charAt(Number(value % 62n)) + out;
    value /= 62n;
  }
  return out.padStart(43, "0");
}

export function newRequestId(): string {
  return ulid();
}

export function newEventId(): string {
  return `evt_${ulid()}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** whk_test_ + 32 random bytes (base62). The prefix is what the dashboard shows. */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = API_KEY_PREFIX + base62(randomBytes(32));
  return { key, prefix: key.slice(0, API_KEY_PREFIX.length + 4), keyHash: sha256Hex(key) };
}

export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/** 32-byte random session token; only its SHA-256 is stored. */
export function generateSessionToken(): { token: string; id: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, id: sha256Hex(token) };
}
