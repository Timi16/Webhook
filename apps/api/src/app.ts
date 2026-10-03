import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Env } from "./config/env.js";
import type { PrismaClient } from "./db/prisma.js";
import type { Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { globalRateLimit } from "./middleware/rateLimit.js";
import { requestId } from "./middleware/requestId.js";
import { createHealthRepo } from "./modules/health/repo.js";
import { createHealthRouter } from "./modules/health/routes.js";
import { createHealthService } from "./modules/health/service.js";

export interface AppDeps {
  env: Env;
  logger: Logger;
  prisma: PrismaClient;
}

/** Middleware order is fixed (docs/Backend.md, "Middleware order"). */
export function buildApp({ env, logger, prisma }: AppDeps): Express {
  const app = express();

  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id }));
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
  app.use(globalRateLimit());

  app.use(createHealthRouter(createHealthService(createHealthRepo(prisma))));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
