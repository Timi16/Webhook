import {
  eventIdParamSchema,
  listPaymentsQuerySchema,
  paymentDetailResponse,
  paymentListResponse,
} from "@webhook/shared";
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
      response: paymentListResponse,
      summary: "List detected payments",
      description:
        "Payments to your watched wallets, newest first, each with the outcome for every watch that evaluated it. Filter by watch, wallet, outcome or ledger close time.",
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
      response: paymentDetailResponse,
      summary: "Get a payment with rule-by-rule results",
      description:
        "One payment with a pass or fail for each rule (asset, amount, memo, sender) and the webhook events it produced.",
      tag,
      auth: "any",
      params: eventIdParamSchema,
    },
    ({ auth, params }) => service.get(auth.developerId, params.eventId),
  );

  return router;
}
