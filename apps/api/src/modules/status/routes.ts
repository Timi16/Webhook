import { statusResponse } from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { StatusService } from "./service.js";

export function createStatusRouter(api: Api, service: StatusService): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/status",
      response: statusResponse,
      summary: "Service status and 90-day uptime",
      description:
        "Each part of the service (API, payment detection, webhook delivery) with its state right now and its uptime day by day for the last 90 days. Uptime comes from a check the service makes every minute; a day with `no_data` is one where the monitor was not running.",
      tag: "Health",
      auth: "none",
    },
    () => service.get(),
  );

  return router;
}
