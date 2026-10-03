import {
  createWatchSchema,
  idParamSchema,
  listWatchesQuerySchema,
  updateWatchSchema,
  watchDetailResponse,
  watchEnvelope,
  watchListResponse,
  watchWithWarningsResponse,
} from "@webhook/shared";
import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { WatchesService } from "./service.js";

export function createWatchesRouter(api: Api, service: WatchesService): Router {
  const router = Router();
  const tag = "Watches";
  const params = idParamSchema;

  api(
    router,
    {
      method: "get",
      path: "/v1/watches",
      response: watchListResponse,
      summary: "List watches",
      tag,
      auth: "any",
      query: listWatchesQuerySchema,
    },
    ({ auth, query }) => service.list(auth.developerId, query),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/watches",
      response: watchWithWarningsResponse,
      summary: "Watch a wallet",
      tag,
      auth: "any",
      status: 201,
      body: createWatchSchema,
    },
    ({ auth, body }) => service.create(auth.developerId, body),
  );
  api(
    router,
    {
      method: "get",
      path: "/v1/watches/:id",
      response: watchDetailResponse,
      summary: "Get a watch with 24 h stats",
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
      path: "/v1/watches/:id",
      response: watchWithWarningsResponse,
      summary: "Update a watch (applies from the next ledger)",
      tag,
      auth: "any",
      params,
      body: updateWatchSchema,
    },
    ({ auth, params, body }) => service.update(auth.developerId, params.id, body),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/watches/:id/pause",
      response: watchEnvelope,
      summary: "Pause a watch",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.pause(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "post",
      path: "/v1/watches/:id/resume",
      response: watchEnvelope,
      summary: "Resume a watch",
      tag,
      auth: "any",
      params,
    },
    ({ auth, params }) => service.resume(auth.developerId, params.id),
  );
  api(
    router,
    {
      method: "delete",
      path: "/v1/watches/:id",
      summary: "Delete a watch (history kept)",
      tag,
      auth: "any",
      status: 204,
      params,
    },
    ({ auth, params }) => service.remove(auth.developerId, params.id),
  );

  return router;
}
