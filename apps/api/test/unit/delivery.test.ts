import { describe, expect, it } from "vitest";
import { classifyAttempt } from "../../src/delivery/endpointHealth.js";
import {
  checkUrlShape,
  isBlockedAddress,
  mapError,
  UrlPolicyError,
} from "../../src/delivery/safeHttp.js";
import { MAX_ATTEMPTS, nextDelayMs, RETRY_DELAYS_SECONDS } from "../../src/delivery/schedule.js";
import { buildHeaders } from "../../src/delivery/signer.js";
import { signPayload } from "../../src/lib/hmac.js";

describe("retry schedule", () => {
  it("uses 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h after failed attempts 1 to 9", () => {
    const delays = Array.from({ length: 9 }, (_, i) => nextDelayMs(i + 1, () => 0.5));
    expect(delays).toEqual(
      [30, 120, 600, 1800, 3600, 10800, 21600, 43200, 86400].map((s) => s * 1000),
    );
    expect(RETRY_DELAYS_SECONDS.reduce((a, b) => a + b, 0) / 86_400).toBeCloseTo(2, 0); // about 2 days in total
  });

  it("applies +/-20% jitter", () => {
    expect(nextDelayMs(1, () => 0)).toBe(24_000);
    expect(nextDelayMs(1, () => 0.999999)).toBeLessThanOrEqual(36_000);
    for (let i = 0; i < 200; i++) {
      const delay = nextDelayMs(2)!;
      expect(delay).toBeGreaterThanOrEqual(96_000);
      expect(delay).toBeLessThanOrEqual(144_000);
    }
  });

  it("has no delay after the 10th attempt", () => {
    expect(nextDelayMs(MAX_ATTEMPTS)).toBeNull();
    expect(nextDelayMs(11)).toBeNull();
    expect(nextDelayMs(0)).toBeNull();
  });
});

describe("attempt classification", () => {
  it("2xx delivers, 410 is gone, everything else retries until attempt 10", () => {
    expect(classifyAttempt(200, 1)).toBe("delivered");
    expect(classifyAttempt(204, 10)).toBe("delivered");
    expect(classifyAttempt(410, 1)).toBe("gone");
    expect(classifyAttempt(500, 1)).toBe("retry");
    expect(classifyAttempt(404, 9)).toBe("retry");
    expect(classifyAttempt(302, 3)).toBe("retry");
    expect(classifyAttempt(null, 9)).toBe("retry");
    expect(classifyAttempt(500, 10)).toBe("exhausted");
    expect(classifyAttempt(null, 12)).toBe("exhausted");
  });
});

describe("signed headers", () => {
  it("sends the event ID, timestamp, attempt and a v1 signature over timestamp.body", () => {
    const headers = buildHeaders({
      eventId: "evt_1",
      attempt: 3,
      timestamp: 1_790_000_000,
      rawBody: '{"a":1}',
      secrets: ["whsec_a"],
    });
    expect(headers).toEqual({
      "Content-Type": "application/json",
      "User-Agent": "Webhook/1.0",
      "Webhook-Id": "evt_1",
      "Webhook-Timestamp": "1790000000",
      "Webhook-Attempt": "3",
      "Webhook-Signature": `v1=${signPayload("whsec_a", 1_790_000_000, '{"a":1}')}`,
    });
  });

  it("sends both signatures, new first, during a rotation", () => {
    const headers = buildHeaders({
      eventId: "evt_1",
      attempt: 1,
      timestamp: 5,
      rawBody: "{}",
      secrets: ["whsec_new", "whsec_old"],
    });
    expect(headers["Webhook-Signature"]).toBe(
      `v1=${signPayload("whsec_new", 5, "{}")}, v1=${signPayload("whsec_old", 5, "{}")}`,
    );
  });
});

describe("SSRF range checks", () => {
  it.each([
    "127.0.0.1",
    "127.8.8.8",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.127.255.255",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "::ffff:10.0.0.1",
    "::ffff:8.8.8.8",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it("only accepts https on port 443 or 8443 without credentials", () => {
    expect(checkUrlShape("https://a.example.com/x").hostname).toBe("a.example.com");
    expect(checkUrlShape("https://a.example.com:8443/x").port).toBe("8443");
    for (const url of [
      "http://a.example.com",
      "https://a.example.com:444",
      "https://u:p@a.example.com",
      "https://u@a.example.com",
      "nope",
    ]) {
      expect(() => checkUrlShape(url), url).toThrow(UrlPolicyError);
    }
    // Local development escape hatch.
    expect(checkUrlShape("http://localhost:4100/x", { allowInsecure: true }).port).toBe("4100");
    expect(() => checkUrlShape("http://u:p@localhost:4100/x", { allowInsecure: true })).toThrow(
      UrlPolicyError,
    );
  });

  it("maps low-level errors to the delivery error codes", () => {
    const withCode = (code: string) =>
      Object.assign(new Error("x"), { cause: Object.assign(new Error("y"), { code }) });
    expect(mapError(withCode("ENOTFOUND"))).toBe("DNS");
    expect(mapError(withCode("ECONNREFUSED"))).toBe("CONN_REFUSED");
    expect(mapError(withCode("ECONNRESET"))).toBe("CONN_REFUSED");
    expect(mapError(withCode("DEPTH_ZERO_SELF_SIGNED_CERT"))).toBe("TLS");
    expect(mapError(withCode("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe("TLS");
    expect(mapError(withCode("UND_ERR_HEADERS_TIMEOUT"))).toBe("TIMEOUT");
    expect(mapError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe("TIMEOUT");
    expect(mapError(withCode("SSRF_BLOCKED"))).toBe("SSRF_BLOCKED");
  });
});
