import dns from "node:dns";
import net from "node:net";
import ipaddr from "ipaddr.js";
import { Agent, request } from "undici";

export type DeliveryErrorCode =
  "TIMEOUT" | "DNS" | "CONN_REFUSED" | "TLS" | "SSRF_BLOCKED" | "REDIRECT" | "BODY_TOO_LARGE";

export const MAX_RESPONSE_BYTES = 64 * 1024;
export const SNIPPET_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const ALLOWED_PORTS = new Set(["", "443", "8443"]);

/**
 * Only plain public unicast addresses are allowed. Everything else is blocked: loopback,
 * private, link-local (incl. 169.254.169.254), CGNAT, 0.0.0.0/8, multicast, broadcast,
 * reserved, IPv6 ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 and the other transition ranges.
 */
export function isBlockedAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return true;
  return ipaddr.parse(address).range() !== "unicast";
}

export class UrlPolicyError extends Error {
  constructor(
    readonly code: "INSECURE_URL" | "SSRF_BLOCKED" | "UNRESOLVABLE",
    message: string,
  ) {
    super(message);
  }
}

export interface UrlPolicy {
  /** Local development only: allow http, any port and private addresses. */
  allowInsecure?: boolean;
  lookup?: LookupAll;
}

type LookupAll = (hostname: string) => Promise<{ address: string; family: number }[]>;

const systemLookup: LookupAll = (hostname) => dns.promises.lookup(hostname, { all: true });

/** https only, no credentials, port 443 or 8443. */
export function checkUrlShape(raw: string, policy: UrlPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlPolicyError("INSECURE_URL", "Endpoint URL is not a valid URL");
  }
  if (url.username || url.password) {
    throw new UrlPolicyError("INSECURE_URL", "Endpoint URL must not contain credentials");
  }
  if (policy.allowInsecure) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new UrlPolicyError("INSECURE_URL", "Endpoint URL must use https");
    }
    return url;
  }
  if (url.protocol !== "https:")
    throw new UrlPolicyError("INSECURE_URL", "Endpoint URL must use https");
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UrlPolicyError("INSECURE_URL", "Endpoint URL must use port 443 or 8443");
  }
  return url;
}

function hostOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Save-time check: the URL is well-formed and every address it resolves to is public. */
export async function assertUrlAllowed(raw: string, policy: UrlPolicy = {}): Promise<URL> {
  const url = checkUrlShape(raw, policy);
  if (policy.allowInsecure) return url;
  const host = hostOf(url);
  if (net.isIP(host)) {
    if (isBlockedAddress(host))
      throw new UrlPolicyError("SSRF_BLOCKED", "Endpoint address is not public");
    return url;
  }
  let addresses: { address: string }[];
  try {
    addresses = await (policy.lookup ?? systemLookup)(host);
  } catch {
    throw new UrlPolicyError("UNRESOLVABLE", "Endpoint hostname does not resolve");
  }
  if (addresses.length === 0)
    throw new UrlPolicyError("UNRESOLVABLE", "Endpoint hostname does not resolve");
  if (addresses.some((a) => isBlockedAddress(a.address))) {
    throw new UrlPolicyError("SSRF_BLOCKED", "Endpoint resolves to a private or internal address");
  }
  return url;
}

export interface HttpResult {
  statusCode: number | null;
  error: DeliveryErrorCode | null;
  /** First 1 KB of the response body, as plain text. */
  snippet: string | null;
  durationMs: number;
}

export interface SafeHttpClient {
  post(url: string, headers: Record<string, string>, body: string): Promise<HttpResult>;
  close(): Promise<void>;
}

export interface SafeHttpOptions extends UrlPolicy {
  timeoutMs?: number;
  /** Extra TLS options for tests (e.g. a private CA). */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean };
}

class SsrfBlockedError extends Error {
  readonly code = "SSRF_BLOCKED";
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const e = current as { code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof e.code === "string") codes.push(e.code);
    if (typeof e.name === "string") codes.push(e.name);
    if (Array.isArray(e.errors)) for (const inner of e.errors) codes.push(...errorCodes(inner));
    current = e.cause;
  }
  return codes;
}

export function mapError(err: unknown): DeliveryErrorCode {
  const codes = errorCodes(err);
  const has = (...wanted: string[]) => codes.some((c) => wanted.includes(c));
  if (has("SSRF_BLOCKED")) return "SSRF_BLOCKED";
  if (
    has(
      "TimeoutError",
      "AbortError",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ETIMEDOUT",
    )
  ) {
    return "TIMEOUT";
  }
  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_NODATA", "EAI_NONAME")) return "DNS";
  if (
    codes.some(
      (c) =>
        c.startsWith("ERR_TLS") ||
        c.startsWith("ERR_SSL") ||
        c.includes("CERT") ||
        c === "EPROTO" ||
        c === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        c === "SELF_SIGNED_CERT_IN_CHAIN",
    )
  ) {
    return "TLS";
  }
  return "CONN_REFUSED";
}

/**
 * The only HTTP client the dispatcher uses. DNS is resolved once, every resolved address is
 * checked, and the socket connects to that exact address, so a hostname cannot be re-pointed
 * at an internal IP between the check and the connect (DNS rebinding).
 */
export function createSafeHttpClient(options: SafeHttpOptions = {}): SafeHttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lookupAll = options.lookup ?? systemLookup;

  const guardedLookup: net.LookupFunction = (hostname, lookupOptions, callback) => {
    lookupAll(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (!first) {
          callback(
            Object.assign(new Error(`no addresses for ${hostname}`), { code: "ENOTFOUND" }),
            "",
            0,
          );
          return;
        }
        if (!options.allowInsecure && addresses.some((a) => isBlockedAddress(a.address))) {
          callback(new SsrfBlockedError(`${hostname} resolves to a blocked address`), "", 0);
          return;
        }
        if (lookupOptions.all) callback(null, [{ address: first.address, family: first.family }]);
        else callback(null, first.address, first.family);
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 0),
    );
  };

  const agent = new Agent({
    connect: { lookup: guardedLookup, timeout: timeoutMs, ...options.tls },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  return {
    async post(rawUrl, headers, body) {
      const started = performance.now();
      const finish = (
        statusCode: number | null,
        error: DeliveryErrorCode | null,
        snippet: string | null,
      ) => ({
        statusCode,
        error,
        snippet,
        durationMs: Math.round(performance.now() - started),
      });

      let url: URL;
      try {
        url = checkUrlShape(rawUrl, options);
      } catch {
        return finish(null, "SSRF_BLOCKED", null);
      }
      // IP-literal hosts never go through the lookup hook, so check them here.
      const host = hostOf(url);
      if (!options.allowInsecure && net.isIP(host) && isBlockedAddress(host)) {
        return finish(null, "SSRF_BLOCKED", null);
      }

      try {
        // undici never follows redirects unless a redirect interceptor is installed; none is.
        const res = await request(url, {
          method: "POST",
          headers,
          body,
          dispatcher: agent,
          signal: AbortSignal.timeout(timeoutMs),
        });

        // Destroying an unread body emits an abort error on the stream; it is expected here.
        res.body.on("error", () => {});
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.body.destroy();
          return finish(res.statusCode, "REDIRECT", null);
        }

        const chunks: Buffer[] = [];
        let kept = 0;
        let total = 0;
        let tooLarge = false;
        for await (const chunk of res.body) {
          const buf = chunk as Buffer;
          total += buf.length;
          if (kept < SNIPPET_BYTES) {
            const part = buf.subarray(0, SNIPPET_BYTES - kept);
            chunks.push(part);
            kept += part.length;
          }
          if (total > MAX_RESPONSE_BYTES) {
            tooLarge = true;
            break; // leaving the loop destroys the stream
          }
        }
        const snippet =
          kept > 0 ? Buffer.concat(chunks).toString("utf8").replaceAll("\u0000", "") : null;
        // The status is still honoured when the body is oversized; the error is informational.
        return finish(res.statusCode, tooLarge ? "BODY_TOO_LARGE" : null, snippet);
      } catch (err) {
        return finish(null, mapError(err), null);
      }
    },
    async close() {
      await agent.close().catch(() => {});
    },
  };
}
