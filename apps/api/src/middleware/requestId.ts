import type { RequestHandler } from "express";
import { newRequestId } from "../lib/ids.js";

// Only accept caller-supplied IDs that are safe to echo into headers and logs.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const id = incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : newRequestId();
  req.id = id;
  res.setHeader("X-Request-Id", id);
  next();
};
