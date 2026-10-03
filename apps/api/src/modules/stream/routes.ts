import { Router } from "express";
import type { Api } from "../../openapi/registry.js";
import type { StreamHub } from "./service.js";

export function createStreamRouter(api: Api, hub: StreamHub): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/v1/stream",
      summary: "Live updates (Server-Sent Events)",
      tag: "Stream",
      auth: "session",
    },
    ({ auth, res }) => {
      res.status(200).set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      res.write(": connected\n\n");
      hub.add(auth.developerId, res);
    },
  );

  return router;
}
