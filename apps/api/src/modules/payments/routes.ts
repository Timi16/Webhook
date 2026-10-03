import { eventIdParamSchema, listPaymentsQuerySchema } from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { PaymentsService } from "./service.js";

export function createPaymentsRouter(api: Api, service: PaymentsService): Router {
  const router = Router();
  const tag = "Payments";

  api(
    router,
    {
      method: "get",
      path: "/v1/payments",
      summary: "List detected payments",
      tag,
      auth: "any",
      query: listPaymentsQuerySchema,
    },
    ({ auth, query }) => service.list(auth.developerId, query),
  );
  api(
    router,
    {
      method: "get",
      path: "/v1/payments/:eventId",
      summary: "Get a payment with rule-by-rule results",
      tag,
      auth: "any",
      params: eventIdParamSchema,
    },
    ({ auth, params }) => service.get(auth.developerId, params.eventId),
  );

  return router;
}
