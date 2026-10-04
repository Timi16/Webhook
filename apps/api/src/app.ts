import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Env } from "./config/env.js";
import type { PgListener } from "./db/notify.js";
import type { PrismaClient } from "./db/prisma.js";
import type { UrlPolicy } from "./delivery/safeHttp.js";
import { createHorizonClient, type HorizonClient } from "./lib/horizon.js";
import type { Logger } from "./lib/logger.js";
import { createMailer, type Mailer } from "./lib/mailer.js";
import { createAuth } from "./middleware/auth.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import {
  createRateLimiters,
  DEFAULT_RATE_LIMITS,
  type RateLimits,
} from "./middleware/rateLimit.js";
import { requestId } from "./middleware/requestId.js";
import { requireOrigin } from "./middleware/requireOrigin.js";
import { createAccountsRouter } from "./modules/accounts/routes.js";
import { createAuditRouter, createAuditWriter } from "./modules/audit/routes.js";
import { createApiKeysRepo } from "./modules/apiKeys/repo.js";
import { createApiKeysRouter } from "./modules/apiKeys/routes.js";
import { createApiKeysService } from "./modules/apiKeys/service.js";
import { createAuthRepo } from "./modules/auth/repo.js";
import { createAuthRouter } from "./modules/auth/routes.js";
import { createAuthService } from "./modules/auth/service.js";
import { createEndpointsRepo } from "./modules/endpoints/repo.js";
import { createEndpointsRouter } from "./modules/endpoints/routes.js";
import { createEndpointsService } from "./modules/endpoints/service.js";
import { createEventsRepo } from "./modules/events/repo.js";
import { createEventsRouter } from "./modules/events/routes.js";
import { createEventsService } from "./modules/events/service.js";
import { createHealthRepo } from "./modules/health/repo.js";
import { createHealthRouter } from "./modules/health/routes.js";
import { createHealthService } from "./modules/health/service.js";
import { createOverviewRepo } from "./modules/overview/repo.js";
import { createOverviewRouter } from "./modules/overview/routes.js";
import { createOverviewService } from "./modules/overview/service.js";
import { createPaymentsRepo } from "./modules/payments/repo.js";
import { createPaymentsRouter } from "./modules/payments/routes.js";
import { createPaymentsService } from "./modules/payments/service.js";
import { createStatusRepo } from "./modules/status/repo.js";
import { createStatusRouter } from "./modules/status/routes.js";
import { createStatusService } from "./modules/status/service.js";
import { createStreamRouter } from "./modules/stream/routes.js";
import { StreamHub } from "./modules/stream/service.js";
import { createWatchesRepo } from "./modules/watches/repo.js";
import { createWatchesRouter } from "./modules/watches/routes.js";
import { createWatchesService } from "./modules/watches/service.js";
import { createApi, createRegistry } from "./openapi/registry.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
  /** Feeds the SSE stream. Without it the stream connects but stays silent (tests). */
  listener?: PgListener;
  // Everything below has a production default and exists so tests can substitute it.
  horizon?: HorizonClient;
  mailer?: Mailer;
  rateLimits?: Partial<RateLimits>;
  urlPolicy?: UrlPolicy;
  loginDelayMs?: number;
  testWaitMs?: number;
  /** Per-developer limits. Defaults: 20 endpoints, 100 watches, 20 active API keys. */
  quotas?: { endpoints?: number; watches?: number; apiKeys?: number };
}

/** Middleware order is fixed (docs/Backend.md, "Middleware order"). */
export function buildApp(deps: AppDeps): Express {
  const { env, logger, prisma } = deps;
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      serializers: {
        // Log the path only: query strings are developer input and may hold a pasted secret key.
        req(req: { url?: string; query?: unknown }) {
          if (typeof req.url === "string") req.url = req.url.split("?")[0];
          delete req.query;
          return req;
        },
      },
    }),
  );
  app.use(
    helmet({
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      xContentTypeOptions: true,
      xFrameOptions: { action: "deny" },
      referrerPolicy: { policy: "no-referrer" },
    }),
  );
  app.use(cors({ origin: env.DASHBOARD_ORIGIN, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());

  const limiters = createRateLimiters({ ...DEFAULT_RATE_LIMITS, ...deps.rateLimits });
  app.use(limiters.global);

  const registry = createRegistry();
  const originGuard = requireOrigin(env.DASHBOARD_ORIGIN);
  const { requireAny, requireSession } = createAuth(prisma);
  const api = createApi({
    registry,
    requireAny,
    requireSession,
    requireOrigin: originGuard,
    apiPreAuthLimit: limiters.apiPreAuth,
    apiLimit: limiters.api,
    audit: createAuditWriter(prisma, logger),
  });

  const mailer = deps.mailer ?? createMailer(env, logger);
  const horizon = deps.horizon ?? createHorizonClient(env.HORIZON_URL);
  const urlPolicy = deps.urlPolicy ?? {
    allowInsecure: env.ALLOW_INSECURE_WEBHOOK_TARGETS === "true",
  };
  const hub = new StreamHub();
  if (deps.listener) hub.attach(deps.listener);

  app.use(createHealthRouter(api, createHealthService(createHealthRepo(prisma))));
  app.use(createStatusRouter(api, createStatusService(createStatusRepo(prisma))));
  app.use(
    createAuthRouter(
      api,
      createAuthService(createAuthRepo(prisma), env, mailer, {
        ...(deps.loginDelayMs !== undefined ? { loginDelayMs: deps.loginDelayMs } : {}),
        onSessionEnded: (sessionId) => hub.closeSession(sessionId),
        onSessionsEnded: (developerId, except) => hub.closeDeveloper(developerId, except),
      }),
      env,
      { authLimit: limiters.auth, requireOrigin: originGuard },
    ),
  );
  app.use(
    createApiKeysRouter(api, createApiKeysService(createApiKeysRepo(prisma), deps.quotas?.apiKeys)),
  );
  app.use(
    createEndpointsRouter(
      api,
      createEndpointsService(createEndpointsRepo(prisma), env, {
        urlPolicy,
        ...(deps.quotas?.endpoints !== undefined ? { maxEndpoints: deps.quotas.endpoints } : {}),
        ...(deps.testWaitMs !== undefined ? { testWaitMs: deps.testWaitMs } : {}),
      }),
    ),
  );
  app.use(
    createWatchesRouter(
      api,
      createWatchesService(createWatchesRepo(prisma), horizon, deps.quotas?.watches),
    ),
  );
  app.use(createOverviewRouter(api, createOverviewService(createOverviewRepo(prisma))));
  app.use(createAccountsRouter(api, horizon));
  app.use(createPaymentsRouter(api, createPaymentsService(createPaymentsRepo(prisma))));
  app.use(createEventsRouter(api, createEventsService(createEventsRepo(prisma))));
  app.use(createAuditRouter(api, prisma));
  app.use(createStreamRouter(api, hub));

  app.use(notFoundHandler);
  app.use(errorHandler);

  app.locals.registry = registry;
  app.locals.streamHub = hub;
  return app;
}
