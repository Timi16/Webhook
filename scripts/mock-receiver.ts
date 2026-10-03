// Scriptable webhook receiver for local development and the delivery tests.
//
//   pnpm --filter @webhook/scripts mock-receiver            # http://localhost:4100
//   PORT=4200 WEBHOOK_SECRET=whsec_... pnpm --filter @webhook/scripts mock-receiver
//
// Mode per request with ?mode=..., or for all requests with POST /_admin/mode {"mode":"500"}.
// Modes: ok, 500, timeout, redirect, gone, slow, large, flaky:N (fail the first N, then ok).
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";

export type ReceiverMode =
  "ok" | "500" | "timeout" | "redirect" | "gone" | "slow" | "large" | `flaky:${number}`;

export interface ReceivedRequest {
  path: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: number;
}

export interface MockReceiver {
  url: string;
  port: number;
  requests: ReceivedRequest[];
  /** Highest number of requests being handled at once, per path. */
  maxConcurrent: Map<string, number>;
  setMode(mode: ReceiverMode): void;
  reset(): void;
  close(): Promise<void>;
}

export interface MockReceiverOptions {
  port?: number;
  mode?: ReceiverMode;
  slowMs?: number;
  tls?: { key: string; cert: string };
  onRequest?: (request: ReceivedRequest) => void;
}

/** The same check the docs' verifyWebhook snippet does. */
export function verifyWebhook(
  secret: string,
  headers: Record<string, string>,
  rawBody: string,
  toleranceSeconds = 300,
): boolean {
  const timestamp = headers["webhook-timestamp"] ?? "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > toleranceSeconds
  )
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return (headers["webhook-signature"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startMockReceiver(options: MockReceiverOptions = {}): Promise<MockReceiver> {
  let mode: ReceiverMode = options.mode ?? "ok";
  let flakyFailures = 0;
  const slowMs = options.slowMs ?? 2_000;
  const requests: ReceivedRequest[] = [];
  const active = new Map<string, number>();
  const maxConcurrent = new Map<string, number>();
  const hanging = new Set<ServerResponse>();

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://receiver.local");
    const body = await readBody(req);

    if (url.pathname === "/_admin/mode" && req.method === "POST") {
      mode = (JSON.parse(body) as { mode: ReceiverMode }).mode;
      flakyFailures = 0;
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/_admin/requests") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(requests));
      return;
    }

    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
    const received: ReceivedRequest = { path: url.pathname, headers, body, receivedAt: Date.now() };
    requests.push(received);
    options.onRequest?.(received);

    const running = (active.get(url.pathname) ?? 0) + 1;
    active.set(url.pathname, running);
    maxConcurrent.set(url.pathname, Math.max(maxConcurrent.get(url.pathname) ?? 0, running));
    const done = () => active.set(url.pathname, (active.get(url.pathname) ?? 1) - 1);

    let current = (url.searchParams.get("mode") as ReceiverMode | null) ?? mode;
    if (current.startsWith("flaky:")) {
      const failFirst = parseInt(current.slice("flaky:".length), 10);
      current = flakyFailures++ < failFirst ? "500" : "ok";
    }

    switch (current) {
      case "500":
        res.writeHead(500, { "content-type": "text/plain" }).end("mock receiver: internal error");
        break;
      case "gone":
        res.writeHead(410).end("gone");
        break;
      case "redirect":
        res.writeHead(302, { location: "/redirected" }).end();
        break;
      case "timeout":
        hanging.add(res); // never answers
        res.on("close", () => hanging.delete(res));
        req.on("close", done);
        return;
      case "slow":
        await new Promise((resolve) => setTimeout(resolve, slowMs));
        res.writeHead(200).end("slow ok");
        break;
      case "large":
        res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(100 * 1024));
        break;
      default:
        res.writeHead(200, { "content-type": "application/json" }).end('{"received":true}');
    }
    done();
  };

  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handler(req, res).catch(() => res.destroy());
  };
  const server: Server = options.tls
    ? createHttpsServer(options.tls, listener)
    : createServer(listener);
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${port}`,
    port,
    requests,
    maxConcurrent,
    setMode(next) {
      mode = next;
      flakyFailures = 0;
    },
    reset() {
      requests.length = 0;
      maxConcurrent.clear();
      flakyFailures = 0;
      mode = options.mode ?? "ok";
    },
    close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.WEBHOOK_SECRET;
  const receiver = await startMockReceiver({
    port: parseInt(process.env.PORT ?? "4100", 10),
    onRequest: (request) => {
      const signature = secret
        ? verifyWebhook(secret, request.headers, request.body)
          ? "valid"
          : "INVALID"
        : "not checked";
      let type = "?";
      try {
        type = (JSON.parse(request.body) as { type?: string }).type ?? "?";
      } catch {
        // not JSON
      }
      console.log(
        `${new Date().toISOString()} ${request.path} id=${request.headers["webhook-id"]} attempt=${request.headers["webhook-attempt"]} type=${type} signature=${signature}`,
      );
    },
  });
  console.log(
    `mock receiver listening on ${receiver.url} (set WEBHOOK_SECRET to verify signatures)`,
  );
}
