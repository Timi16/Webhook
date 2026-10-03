import { Router } from "express";
import type { HealthService } from "./service.js";

export function createHealthRouter(service: HealthService): Router {
  const router = Router();

  router.get("/health", async (_req, res) => {
    const { httpStatus, body } = await service.check();
    res.status(httpStatus).json(body);
  });

  return router;
}
