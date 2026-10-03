import {
  apiKeyCreatedResponse,
  apiKeyListResponse,
  createApiKeySchema,
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
      method: "delete",
      path: "/v1/api-keys/:id",
      summary: "Revoke an API key",
      tag,
      auth: "session",
      status: 204,
      params: idParamSchema,
    },
    ({ auth, params }) => service.revoke(auth.developerId, params.id),
  );

  return router;
}
