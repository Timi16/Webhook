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

export function generateOpenApiDocument(registry: OpenAPIRegistry) {
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Webhook API",
      version: "1.0.0",
      description:
        "Stellar Testnet payment webhooks: register a wallet, get a signed event when it is paid.",
    },
  });
}
