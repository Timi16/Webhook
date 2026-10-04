import {
  createEndpointSchema,
  endpointCreatedResponse,
  endpointDetailResponse,
  endpointEnvelope,
  endpointListResponse,
  idParamSchema,
  replayEndpointSchema,
  replayResponse,
  rotatedSecretResponse,
  testWebhookResponse,
  updateEndpointSchema,
} from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { EndpointsService } from "./service.js";

export function createEndpointsRouter(api: Api, service: EndpointsService): Router {
  const router = Router();
  const tag = "Endpoints";
  const params = idParamSchema;

  api(
    router,
    {
      method: "get",
      path: "/v1/endpoints",
      response: endpointListResponse,
      summary: "List endpoints",
      description: "All your endpoints, newest first.",
      tag,
      auth: "any",
    },
    ({ auth }) => service.list(auth.developerId),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/endpoints",
      scope: "endpoints:write",
      response: endpointCreatedResponse,
      summary: "Create an endpoint (secret shown once)",
      description:
        "Registers a URL and returns its signing secret, shown only here. The URL is checked now and again before every delivery.",
      tag,
      auth: "any",
      status: 201,
      body: createEndpointSchema,
    },
    ({ auth, body }) => service.create(auth.developerId, body),
  );
  api(
    router,
    {
      method: "get",
      path: "/v1/endpoints/:id",
      response: endpointDetailResponse,
      summary: "Get an endpoint with recent failure stats",
      description:
        "One endpoint with delivery counts for the last 24 hours and its most recent attempt.",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.get(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "patch",
      path: "/v1/endpoints/:id",
      scope: "endpoints:write",
      response: endpointEnvelope,
      summary: "Update an endpoint",
      description:
        "Changes the URL or description. A new URL is checked like on creation; deliveries already retrying go to the new URL on their next attempt.",
      tag,
      auth: "any",
      params,
      body: updateEndpointSchema,
    },
    ({ auth, params, body }) => service.update(auth.developerId, params.id, body),
  );
  api(
    router,
    {
      method: "delete",
      path: "/v1/endpoints/:id",
      scope: "endpoints:write",
      summary: "Delete an endpoint",
      description:
        "Deletes the endpoint and cancels its unfinished deliveries. Refused with `409` while an active watch uses it.",
      tag,
      auth: "any",
      status: 204,
      params,
    },
    ({ auth, params }) => service.remove(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/endpoints/:id/rotate-secret",
      scope: "endpoints:write",
      response: rotatedSecretResponse,
      summary: "Rotate the signing secret (old one valid 24 h)",
      description:
        "Returns a new signing secret. For 24 hours webhooks are signed with both the new and the previous secret, so you can deploy without dropping requests.",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.rotateSecret(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/endpoints/:id/test",
      scope: "endpoints:write",
      response: testWebhookResponse,
      summary: "Send a test.ping and return the first attempt",
      description:
        "Sends a `test.ping` event and waits up to 12 seconds for the first attempt. `attempt` is `null` if it has not been sent in that time; the event stays queued.",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.test(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/endpoints/:id/enable",
      scope: "endpoints:write",
      response: endpointEnvelope,
      summary: "Re-enable a disabled endpoint",
      description:
        "Re-enables a disabled endpoint and resets its failure count. Deliveries that were waiting resume; ones that already failed need **replay**.",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.enable(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/endpoints/:id/replay",
      scope: "endpoints:write",
      response: replayResponse,
      summary: "Requeue failed deliveries since a date (max 1,000)",
      description:
        "Queues failed deliveries created since `since` again, up to 1,000. They keep their `Webhook-Id`.",
      tag,
      auth: "any",
      params,
      body: replayEndpointSchema,
    },
    ({ auth, params, body }) => service.replay(auth.developerId, params.id, body.since),
  );

  return router;
}
