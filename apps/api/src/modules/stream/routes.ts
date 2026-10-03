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
      description:
        "Opens a Server-Sent Events stream scoped to the logged-in developer. A comment line is sent every 25 seconds to keep the connection open. At most 5 streams per developer.",
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
      hub.add(auth.developerId, res, auth.sessionId);
    },
  );

  return router;
}
