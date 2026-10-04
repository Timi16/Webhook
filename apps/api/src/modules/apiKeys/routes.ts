import {
  apiKeyCreatedResponse,
  apiKeyEnvelope,
  apiKeyListResponse,
  createApiKeySchema,
  deleteApiKeyQuerySchema,
  idParamSchema,
} from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { ApiKeysService } from "./service.js";

export function createApiKeysRouter(api: Api, service: ApiKeysService): Router {
  const router = Router();
  const tag = "API keys";

  api(
    router,
    {
      method: "get",
      path: "/v1/api-keys",
      response: apiKeyListResponse,
      summary: "List API keys",
      description:
        "Lists keys with their prefix and when they were last used. The key itself is never returned again. A `revokedAt` in the future is the end date of a rolled key.",
      tag,
      auth: "session",
    },
    ({ auth }) => service.list(auth.developerId),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/api-keys",
      response: apiKeyCreatedResponse,
      summary: "Create an API key (shown once)",
      description: "Creates a key. The response is the only time the full key is shown.",
      tag,
      auth: "session",
      status: 201,
      body: createApiKeySchema,
    },
    ({ auth, body }) => service.create(auth.developerId, body.name),
  );
  api(
    router,
    {
      method: "patch",
      path: "/v1/api-keys/:id",
      response: apiKeyEnvelope,
      summary: "Rename an API key",
      description: "Changes the key's name. The key itself is unchanged.",
      tag,
      auth: "session",
      params: idParamSchema,
      body: createApiKeySchema,
    },
    ({ auth, params, body }) => service.rename(auth.developerId, params.id, body.name),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/api-keys/:id/roll",
      response: apiKeyCreatedResponse,
      summary: "Roll an API key",
      description:
        "Returns a new key with the same name, shown once. The old key keeps working for 24 hours so you can deploy the new one first.",
      tag,
      auth: "session",
      status: 201,
      params: idParamSchema,
    },
    ({ auth, params }) => service.roll(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "delete",
      path: "/v1/api-keys/:id",
      summary: "Revoke or delete an API key",
      description:
        "Revokes a key immediately: requests using it get `401`, and it stays in the list for history. With `?permanent=true` the key is removed from the account as well.",
      tag,
      auth: "session",
      status: 204,
      params: idParamSchema,
      query: deleteApiKeyQuerySchema,
    },
    ({ auth, params, query }) =>
      service.remove(auth.developerId, params.id, query.permanent === "true"),
  );

  return router;
}
