import { execFileSync } from "node:child_process";
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

// The Python and Ruby versions on the same page, run with the real interpreters when present.
function has(command: string): boolean {
  try {
    execFileSync(command, ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

interface Case {
  name: string;
  secret: string;
  headers: Record<string, string>;
  body: string;
  tolerance: number;
  expected: boolean;
}

function cases(): Case[] {
  const now = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: "evt_1",
    type: "payment.received",
    data: { memo: "café ☕", amount: "10.0000000" },
  });
  const signed = (timestamp: number, secrets: string[]) =>
    lowercase(buildHeaders({ eventId: "evt_1", attempt: 1, timestamp, rawBody: body, secrets }));
  return [
    {
      name: "real signer",
      secret: "whsec_live",
      headers: signed(now, ["whsec_live"]),
      body,
      tolerance: 300,
      expected: true,
    },
    {
      name: "wrong secret",
      secret: "whsec_other",
      headers: signed(now, ["whsec_live"]),
      body,
      tolerance: 300,
      expected: false,
    },
    {
      name: "altered body",
      secret: "whsec_live",
      headers: signed(now, ["whsec_live"]),
      body: `${body} `,
      tolerance: 300,
      expected: false,
    },
    {
      name: "rotation, new secret",
      secret: "whsec_new",
      headers: signed(now, ["whsec_new", "whsec_old"]),
      body,
      tolerance: 300,
      expected: true,
    },
    {
      name: "rotation, old secret",
      secret: "whsec_old",
      headers: signed(now, ["whsec_new", "whsec_old"]),
      body,
      tolerance: 300,
      expected: true,
    },
    {
      name: "stale timestamp",
      secret: "whsec_live",
      headers: signed(now - 301, ["whsec_live"]),
      body,
      tolerance: 300,
      expected: false,
    },
    {
      name: "missing headers",
      secret: "whsec_live",
      headers: {},
      body,
      tolerance: 300,
      expected: false,
    },
    {
      name: "malformed timestamp",
      secret: "whsec_live",
      headers: { "webhook-timestamp": "12a", "webhook-signature": "v1=00" },
      body,
      tolerance: 300,
      expected: false,
    },
    {
      name: "published test vector",
      secret: vector.secret,
      headers: {
        "webhook-timestamp": String(vector.timestamp),
        "webhook-signature": `v1=${vector.signature}`,
      },
      body: vector.body,
      tolerance: 10_000_000_000,
      expected: true,
    },
  ];
}

function extract(marker: string, language: string): string {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const snippet = new RegExp(
    "```" + language + "[^\\n]*\\n(# " + escaped + "\\n[\\s\\S]*?)```",
  ).exec(page)?.[1];
  if (!snippet) throw new Error(`${marker} snippet not found in the docs page`);
  return snippet;
}

function runIn(command: string, files: Record<string, string>, entry: string): boolean[] {
  const dir = mkdtempSync(join(tmpdir(), "whk-docs-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, "cases.json"), JSON.stringify(cases()));
  return JSON.parse(execFileSync(command, [entry], { cwd: dir, encoding: "utf8" })) as boolean[];
}

describe("docs: verify_webhook in other languages", () => {
  it.skipIf(!has("python3"))("Python snippet agrees with the real signer on every case", () => {
    const results = runIn(
      "python3",
      {
        "verify_webhook.py": extract("verify_webhook.py", "python"),
        "run.py": [
          "import json",
          "from verify_webhook import verify_webhook",
          "cases = json.load(open('cases.json', encoding='utf-8'))",
          "print(json.dumps([verify_webhook(c['secret'], c['headers'], c['body'].encode('utf-8'), c['tolerance']) for c in cases]))",
        ].join("\n"),
      },
      "run.py",
    );
    expect(results).toEqual(cases().map((c) => c.expected));
  });

  it.skipIf(!has("ruby"))("Ruby snippet agrees with the real signer on every case", () => {
    const results = runIn(
      "ruby",
      {
        "verify_webhook.rb": extract("verify_webhook.rb", "ruby"),
        "run.rb": [
          'require "json"',
          'require_relative "verify_webhook"',
          'cases = JSON.parse(File.read("cases.json", encoding: "UTF-8"))',
          'puts JSON.generate(cases.map { |c| verify_webhook(c["secret"], c["headers"], c["body"], c["tolerance"]) })',
        ].join("\n"),
      },
      "run.rb",
    );
    expect(results).toEqual(cases().map((c) => c.expected));
  });
});
