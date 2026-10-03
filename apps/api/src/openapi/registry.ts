import { OpenApiGeneratorV31, OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { SECRET_KEY_ISSUE, errorResponseSchema } from "@webhook/shared";
import type { Request, RequestHandler, Response, Router } from "express";
import type { z } from "zod";
import { AppError } from "../lib/errors.js";
import type { AuthContext } from "../middleware/auth.js";

export type AuthMode = "none" | "session" | "any";

export interface RouteSpec<
  B extends z.ZodType | undefined,
  Q extends z.ZodObject | undefined,
  P extends z.ZodObject | undefined,
> {
  method: "get" | "post" | "patch" | "delete";
  /** Express-style path, e.g. /v1/watches/:id */
  path: string;
  summary: string;
  /** Longer explanation shown in the API reference (Markdown). */
  description?: string;
  tag: string;
  auth: AuthMode;
  /** Success status; 204 sends no body. Default 200. */
  status?: number;
  body?: B;
  query?: Q;
  params?: P;
  /** Shape of the success response body, for the API reference. */
  response?: z.ZodType;
  /** Extra middleware, run before authentication. */
  before?: RequestHandler[];
}

type Infer<T> = T extends z.ZodType ? z.infer<T> : undefined;

export interface RouteContext<B, Q, P> {
  body: B;
  query: Q;
  params: P;
  /** Throws UNAUTHENTICATED if the route is not behind auth. */
  auth: AuthContext;
  req: Request;
  res: Response;
}

export interface ApiDeps {
  registry: OpenAPIRegistry;
  requireAny: RequestHandler;
  requireSession: RequestHandler;
  requireOrigin: RequestHandler;
  apiPreAuthLimit: RequestHandler;
  apiLimit: RequestHandler;
}

/** Postgres cannot store NUL in text or JSON columns. */
function containsNul(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNul);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, inner]) => key.includes("\u0000") || containsNul(inner),
    );
  }
  return false;
}

function parse(schema: z.ZodType | undefined, data: unknown, where: string): unknown {
  if (!schema) return undefined;
  if (containsNul(data)) {
    throw new AppError("VALIDATION_FAILED", `${where}: invalid_character`, {
      details: [{ path: where, issue: "invalid_character" }],
    });
  }
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;

  const details = result.error.issues.map((issue) => ({
    path: issue.path.join(".") || where,
    issue: issue.message,
  }));
  const secret = details.find((d) => d.issue === SECRET_KEY_ISSUE);
  if (secret) {
    throw new AppError(
      "SECRET_KEY_REJECTED",
      "That is a Stellar secret key, not an address. It was not stored or logged; treat it as compromised if it holds real funds.",
      { details: [secret] },
    );
  }
  const first = details[0];
  throw new AppError(
    "VALIDATION_FAILED",
    first ? `${first.path}: ${first.issue}` : "Invalid request",
    {
      details,
    },
  );
}

/**
 * Declares a route once: the same Zod schemas validate the request and describe it in the
 * OpenAPI spec, so the two cannot drift. Handlers only ever see validated input.
 */
export function createApi(deps: ApiDeps) {
  return function route<
    B extends z.ZodType | undefined = undefined,
    Q extends z.ZodObject | undefined = undefined,
    P extends z.ZodObject | undefined = undefined,
  >(
    router: Router,
    spec: RouteSpec<B, Q, P>,
    handler: (ctx: RouteContext<Infer<B>, Infer<Q>, Infer<P>>) => Promise<unknown> | unknown,
  ): void {
    const status = spec.status ?? 200;
    const errorContent = { "application/json": { schema: errorResponseSchema } };
    deps.registry.registerPath({
      method: spec.method,
      path: spec.path.replace(/:(\w+)/g, "{$1}"),
      summary: spec.summary,
      ...(spec.description ? { description: spec.description } : {}),
      tags: [spec.tag],
      security:
        spec.auth === "none"
          ? []
          : spec.auth === "session"
            ? [{ session: [] }]
            : [{ session: [] }, { apiKey: [] }],
      request: {
        ...(spec.params ? { params: spec.params } : {}),
        ...(spec.query ? { query: spec.query } : {}),
        ...(spec.body ? { body: { content: { "application/json": { schema: spec.body } } } } : {}),
      },
      responses: {
        [status]: {
          description: status === 204 ? "No content" : "Success",
          ...(spec.response ? { content: { "application/json": { schema: spec.response } } } : {}),
        },
        400: { description: "Validation failed", content: errorContent },
        ...(spec.auth === "none"
          ? {}
          : { 401: { description: "Unauthenticated", content: errorContent } }),
        429: { description: "Rate limited", content: errorContent },
      },
    });

    const chain: RequestHandler[] = [...(spec.before ?? [])];
    if (spec.auth !== "none") {
      chain.push(
        deps.apiPreAuthLimit,
        spec.auth === "session" ? deps.requireSession : deps.requireAny,
        deps.requireOrigin,
        deps.apiLimit,
      );
    }

    router[spec.method](spec.path, ...chain, async (req, res) => {
      const result = await handler({
        body: parse(spec.body, req.body, "body") as Infer<B>,
        query: parse(spec.query, req.query, "query") as Infer<Q>,
        params: parse(spec.params, req.params, "params") as Infer<P>,
        get auth() {
          if (!req.auth)
            throw new AppError("UNAUTHENTICATED", "A valid session or API key is required");
          return req.auth;
        },
        req,
        res,
      });
      if (res.headersSent) return;
      if (status === 204) res.status(204).end();
      else res.status(status).json(result);
    });
  };
}

export type Api = ReturnType<typeof createApi>;

export function createRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "whk_session",
    description:
      "Dashboard session cookie. State-changing requests must send the dashboard Origin header.",
  });
  registry.registerComponent("securitySchemes", "apiKey", {
    type: "http",
    scheme: "bearer",
    description: "API key: Authorization: Bearer whk_test_...",
  });
  return registry;
}

const API_DESCRIPTION = `
Webhook watches Stellar Testnet wallets and tells your server when they are paid. This reference
covers every endpoint; the guides explain how the pieces fit together.

## Authentication

Send your API key on every request:

\`\`\`
Authorization: Bearer whk_test_...
\`\`\`

Keys are created with a logged-in session (\`POST /v1/api-keys\`) and shown once. The \`/auth\`
endpoints and API-key management use the session cookie instead, and their state-changing requests
must carry an \`Origin\` header equal to the dashboard's origin.

## Errors

Every error has the same shape. \`code\` is stable and safe to branch on; \`requestId\` is also
returned in the \`X-Request-Id\` header.

\`\`\`json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "walletAddress: invalid_stellar_address",
    "details": [{ "path": "walletAddress", "issue": "invalid_stellar_address" }],
    "requestId": "01K6V8Z3M4T7Q2X9B5N1R0C8YD"
  }
}
\`\`\`

- \`VALIDATION_FAILED\` (400): A field is missing, malformed or unknown.
- \`SECRET_KEY_REJECTED\` (400): A Stellar secret key (\`S...\`) was sent where an address belongs.
- \`INSECURE_URL\` (400): Endpoint URL is not HTTPS, has credentials or uses another port than 443 or 8443.
- \`SSRF_BLOCKED\` (400): Endpoint URL resolves to a private or internal address.
- \`UNAUTHENTICATED\` (401): Missing, invalid or revoked credentials.
- \`FORBIDDEN_ORIGIN\` (403): Cookie request without the expected \`Origin\` header.
- \`NOT_FOUND\` (404): The resource does not exist or belongs to someone else.
- \`CONFLICT\` (409): For example an email already in use, or a limit reached.
- \`RATE_LIMITED\` (429): Too many requests. See \`Retry-After\`.
- \`INTERNAL\` (500): Something went wrong on our side.

## Pagination

List endpoints take \`limit\` (1 to 100, default 50) and \`cursor\`, and return \`nextCursor\`.
Pass it back as \`cursor\` for the next page; it is \`null\` on the last page.

## Amounts

Amounts are decimal strings with up to 7 places (\`"10.5"\`). Responses carry both the decimal form
and the exact integer number of stroops (1 unit = 10,000,000 stroops). Never parse them as floats.

## Rate limits

300 requests a minute per developer on \`/v1\`, 60 a minute per IP on public routes and 5 a minute
per IP on the credential endpoints under \`/auth\`.
`;

const TAGS = [
  {
    name: "Health",
    description:
      "Whether the service is up and keeping pace with the ledger. Public, no authentication. Use it for uptime checks.",
  },
  {
    name: "Auth",
    description:
      "Accounts and browser sessions, used by the dashboard. A session is a cookie; every state-changing request must send the dashboard's `Origin` header. Servers should use an API key instead (see **API keys**).",
  },
  {
    name: "API keys",
    description:
      "Keys your servers use to call the API (`Authorization: Bearer whk_test_...`). The full key is shown once when created; only a hash is stored. These endpoints need a session, so a leaked key cannot mint more keys. Up to 20 active keys per developer.",
  },
  {
    name: "Endpoints",
    description:
      "URLs on your server that receive webhooks. Each has its own signing secret, shown once on creation. An endpoint is `ACTIVE`, `FAILING` (recent attempts failed) or `DISABLED` (it answered `410`, or 20 events in a row could not be delivered). URLs must be HTTPS on port 443 or 8443 and resolve to a public address. Up to 20 per developer.",
  },
  {
    name: "Watches",
    description:
      "A watch is a wallet plus the rules a payment must meet: accepted assets, amount, memo and senders. Every payment to the wallet is evaluated by each of its watches and ends `VERIFIED` or `REJECTED`. A watch delivers to one endpoint. Changes apply from the next ledger; events that already exist are never rewritten. Up to 100 per developer.",
  },
  {
    name: "Payments",
    description:
      "Payments detected on your watched wallets, with the result of each rule. This is the record of what happened on the ledger, whether or not a webhook was sent.",
  },
  {
    name: "Events",
    description:
      "Webhook events and their deliveries. An event's payload is fixed when it is created; each delivery lists every attempt with its status code, duration, error and the start of your server's response.",
  },
  {
    name: "Stream",
    description:
      "Live updates for the dashboard over Server-Sent Events. Session only. Event names: `payment.detected`, `delivery.updated`, `endpoint.updated`, `system.notice`.",
  },
];

export function generateOpenApiDocument(
  registry: OpenAPIRegistry,
  serverUrl = "https://api.your-domain.com",
) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Webhook API",
      version: "1.0.0",
      description: API_DESCRIPTION,
    },
    servers: [{ url: serverUrl, description: "Webhook API" }],
    tags: TAGS,
  });
}
