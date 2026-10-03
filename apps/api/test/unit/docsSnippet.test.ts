import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { buildHeaders } from "../../src/delivery/signer.js";

type Verify = (
  secret: string,
  headers: Record<string, string | undefined>,
  rawBody: string,
  tolerance?: number,
) => boolean;

const page = readFileSync(
  new URL("../../../docs/content/docs/verifying-signatures.mdx", import.meta.url),
  "utf8",
);
const vector = JSON.parse(
  readFileSync(new URL("../fixtures/signature.json", import.meta.url), "utf8"),
) as {
  secret: string;
  timestamp: number;
  body: string;
  signature: string;
};

let verifyWebhook: Verify;

beforeAll(async () => {
  // The exact code block developers copy from the docs page.
  const snippet = /```js[^\n]*\n(\/\/ verify-webhook\.mjs\n[\s\S]*?)```/.exec(page)?.[1];
  if (!snippet) throw new Error("verify-webhook snippet not found in the docs page");
  const file = join(mkdtempSync(join(tmpdir(), "whk-docs-")), "verify-webhook.mjs");
  writeFileSync(file, snippet);
  ({ verifyWebhook } = (await import(/* @vite-ignore */ pathToFileURL(file).href)) as {
    verifyWebhook: Verify;
  });
});

/** Lower-cased header names, as Node's HTTP server provides them. */
function lowercase(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

describe("docs: verifyWebhook snippet", () => {
  it("accepts what the real signer sends", () => {
    const rawBody = JSON.stringify({
      id: "evt_1",
      type: "payment.received",
      data: { amount: "10.0000000" },
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = lowercase(
      buildHeaders({ eventId: "evt_1", attempt: 1, timestamp, rawBody, secrets: ["whsec_live"] }),
    );
    expect(verifyWebhook("whsec_live", headers, rawBody)).toBe(true);
    expect(verifyWebhook("whsec_other", headers, rawBody)).toBe(false);
    expect(verifyWebhook("whsec_live", headers, `${rawBody} `)).toBe(false);
  });

  it("accepts either secret while a rotation is in progress", () => {
    const rawBody = "{}";
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = lowercase(
      buildHeaders({
        eventId: "evt_2",
        attempt: 3,
        timestamp,
        rawBody,
        secrets: ["whsec_new", "whsec_old"],
      }),
    );
    expect(verifyWebhook("whsec_new", headers, rawBody)).toBe(true);
    expect(verifyWebhook("whsec_old", headers, rawBody)).toBe(true);
  });

  it("refuses stale, missing and malformed headers", () => {
    const rawBody = "{}";
    const old = Math.floor(Date.now() / 1000) - 301;
    const stale = lowercase(
      buildHeaders({
        eventId: "evt_3",
        attempt: 1,
        timestamp: old,
        rawBody,
        secrets: ["whsec_live"],
      }),
    );
    expect(verifyWebhook("whsec_live", stale, rawBody)).toBe(false);
    expect(verifyWebhook("whsec_live", stale, rawBody, 600)).toBe(true);
    expect(verifyWebhook("whsec_live", {}, rawBody)).toBe(false);
    expect(
      verifyWebhook(
        "whsec_live",
        { "webhook-timestamp": "abc", "webhook-signature": "v1=00" },
        rawBody,
      ),
    ).toBe(false);
    expect(
      verifyWebhook(
        "whsec_live",
        { ...stale, "webhook-timestamp": String(Math.floor(Date.now() / 1000)) },
        rawBody,
      ),
    ).toBe(false);
  });

  it("matches the test vector printed on the docs page", () => {
    for (const value of [vector.secret, String(vector.timestamp), vector.body, vector.signature])
      expect(page).toContain(value);
    const headers = {
      "webhook-timestamp": String(vector.timestamp),
      "webhook-signature": `v1=${vector.signature}`,
    };
    // The vector's timestamp is fixed, so allow any age.
    expect(verifyWebhook(vector.secret, headers, vector.body, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
