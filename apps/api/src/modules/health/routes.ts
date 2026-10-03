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
