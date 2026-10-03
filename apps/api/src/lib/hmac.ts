import { createHmac, timingSafeEqual } from "node:crypto";

/** hex(HMAC_SHA256(secret, timestamp + "." + rawBody)). The key is the UTF-8 bytes of the full secret string. */
export function signPayload(secret: string, timestamp: number, rawBody: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
}

export interface VerifyOptions {
  toleranceSeconds?: number;
  now?: number; // unix seconds
}

/**
 * Reference verifier (the docs snippet mirrors this). Accepts a header with one or more
 * comma-separated `v1=<hex>` signatures, as sent during a secret rotation.
 */
export function verifySignature(
  secret: string,
  header: string,
  timestamp: string,
  rawBody: string,
  options: VerifyOptions = {},
): boolean {
  const ts = /^\d{1,12}$/.test(timestamp) ? parseInt(timestamp, 10) : NaN;
  if (!Number.isFinite(ts)) return false;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > (options.toleranceSeconds ?? 300)) return false;

  const expected = Buffer.from(signPayload(secret, ts, rawBody), "hex");
  return header
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const candidate = Buffer.from(part.slice(3), "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}
