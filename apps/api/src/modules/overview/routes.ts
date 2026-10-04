import { overviewResponse } from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { OverviewService } from "./service.js";

export function createOverviewRouter(api: Api, service: OverviewService): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/v1/overview",
      summary: "Last 24 hours at a glance",
      description:
        "Counts for the last 24 hours: payments evaluated and their outcomes, webhook deliveries by state with the median and 95th-percentile duration of successful attempts, watches by state, and payments per hour for a chart.",
      tag: "Payments",
      auth: "any",
      response: overviewResponse,
    },
    ({ auth }) => service.get(auth.developerId),
  );

  return router;
}
