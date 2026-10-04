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
      description: "Your watches, optionally filtered by wallet or by active state.",
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
      scope: "watches:write",
      response: watchWithWarningsResponse,
      summary: "Watch a wallet",
      description:
        "Starts watching a wallet. It applies from the next ledger, or from up to 24 hours back with `backfillHours`. `warnings` tells you if the account does not exist yet, lacks a trustline for an asset, or duplicates another watch; the watch is saved either way.",
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
      description:
        "One watch with how many payments it verified and rejected in the last 24 hours.",
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
      scope: "watches:write",
      response: watchWithWarningsResponse,
      summary: "Update a watch (applies from the next ledger)",
      description: "Changes any rule except the wallet address. Applies from the next ledger.",
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
      scope: "watches:write",
      response: watchEnvelope,
      summary: "Pause a watch",
      description: "Stops matching new payments. Deliveries already queued continue.",
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
      scope: "watches:write",
      response: watchEnvelope,
      summary: "Resume a watch",
      description:
        "Starts matching again from the next ledger. Payments that arrived while paused stay ignored.",
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
      scope: "watches:write",
      summary: "Delete a watch (history kept)",
      description: "Stops the watch for good. Its payments and events remain available.",
      tag,
      auth: "any",
      status: 204,
      params,
    },
    ({ auth, params }) => service.remove(auth.developerId, params.id),
  );

  return router;
}
