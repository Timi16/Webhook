import {
  deliveryEnvelope,
  eventDetailResponse,
  eventListResponse,
  idParamSchema,
  listEventsQuerySchema,
} from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { EventsService } from "./service.js";

export function createEventsRouter(api: Api, service: EventsService): Router {
  const router = Router();
  const tag = "Events";

  api(
    router,
    {
      method: "get",
      path: "/v1/events",
      response: eventListResponse,
      summary: "List webhook events",
      tag,
      auth: "any",
      query: listEventsQuerySchema,
    },
    ({ auth, query }) => service.list(auth.developerId, query),
  );
  api(
    router,
    {
      method: "get",
      path: "/v1/events/:id",
      response: eventDetailResponse,
      summary: "Get an event with its payload, deliveries and attempts",
      tag,
      auth: "any",
      params: idParamSchema,
    },
    ({ auth, params }) => service.get(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/events/:id/resend",
      response: deliveryEnvelope,
      summary: "Resend an event (same Webhook-Id)",
      tag,
      auth: "any",
      status: 202,
      params: idParamSchema,
    },
    ({ auth, params }) => service.resend(auth.developerId, params.id),
  );

  return router;
}
