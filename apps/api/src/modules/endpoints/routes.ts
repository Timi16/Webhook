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
      response: endpointCreatedResponse,
      summary: "Create an endpoint (secret shown once)",
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
      response: endpointEnvelope,
      summary: "Update an endpoint",
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
      summary: "Delete an endpoint",
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
      response: rotatedSecretResponse,
      summary: "Rotate the signing secret (old one valid 24 h)",
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
      response: testWebhookResponse,
      summary: "Send a test.ping and return the first attempt",
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
      response: endpointEnvelope,
      summary: "Re-enable a disabled endpoint",
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
      response: replayResponse,
      summary: "Requeue failed deliveries since a date (max 1,000)",
      tag,
      auth: "any",
      params,
      body: replayEndpointSchema,
    },
    ({ auth, params, body }) => service.replay(auth.developerId, params.id, body.since),
  );

  return router;
}
