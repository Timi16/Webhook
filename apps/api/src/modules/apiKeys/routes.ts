import {
  apiKeyCreatedResponse,
  apiKeyDetailResponse,
  apiKeyEnvelope,
  apiKeyListResponse,
  createApiKeySchema,
  deleteApiKeyQuerySchema,
  idParamSchema,
  updateApiKeySchema,
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
      audit: {
        action: "api_key.created",
        target: (r) => {
          const k = (r as { apiKey: { id: string; name: string } }).apiKey;
          return { id: k.id, label: k.name };
        },
      },
      response: apiKeyCreatedResponse,
      summary: "Create an API key (shown once)",
      description:
        "Creates a key. The response is the only time the full key is shown. Without `scopes` the key gets every permission; `allowedIps` and `expiresAt` are optional limits.",
      tag,
      auth: "session",
      status: 201,
      body: createApiKeySchema,
    },
    ({ auth, body }) => service.create(auth.developerId, body),
  );
  api(
    router,
    {
      method: "get",
      path: "/v1/api-keys/:id",
      response: apiKeyDetailResponse,
      summary: "Get an API key with its usage",
      description:
        "One key with its request counts for the last 24 hours, hour by hour, and its 20 most recent requests. The log is kept for 7 days and never stores query strings.",
      tag,
      auth: "session",
      params: idParamSchema,
    },
    ({ auth, params }) => service.get(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "patch",
      path: "/v1/api-keys/:id",
      audit: {
        action: "api_key.updated",
        target: (r) => {
          const k = (r as { apiKey: { id: string; name: string } }).apiKey;
          return { id: k.id, label: k.name };
        },
      },
      response: apiKeyEnvelope,
      summary: "Update an API key",
      description:
        "Changes the key's name, note, permissions, allowed IPs or expiry. Send only the fields to change; they apply to the key's next request. The key itself is unchanged.",
      tag,
      auth: "session",
      params: idParamSchema,
      body: updateApiKeySchema,
    },
    ({ auth, params, body }) => service.update(auth.developerId, params.id, body),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/api-keys/:id/roll",
      audit: {
        action: "api_key.rolled",
        target: (r) => {
          const k = (r as { apiKey: { id: string; name: string } }).apiKey;
          return { id: k.id, label: k.name };
        },
      },
      response: apiKeyCreatedResponse,
      summary: "Roll an API key",
      description:
        "Returns a new key with the same name and settings, shown once. The old key keeps working for 24 hours so you can deploy the new one first.",
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
      audit: {
        action: (req) => (req.query.permanent === "true" ? "api_key.deleted" : "api_key.revoked"),
        target: (r) => ({ label: (r as { name: string }).name }),
      },
      summary: "Revoke or delete an API key",
      description:
        "Revokes a key immediately: requests using it get `401`, and it stays in the list for history. With `?permanent=true` the key and its request log are removed from the account as well.",
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
