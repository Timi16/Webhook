import { healthResponse } from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { HealthService } from "./service.js";

export function createHealthRouter(api: Api, service: HealthService): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/health",
      response: healthResponse,
      summary: "Service health",
      description:
        "Returns `ok` or `degraded` with the last ledger processed, how many seconds ingestion is behind and how many deliveries are waiting. Answers `503` when the database is unreachable.",
      tag: "Health",
      auth: "none",
    },
    async ({ res }) => {
      const { httpStatus, body } = await service.check();
      res.status(httpStatus).json(body);
    },
  );

  return router;
}
