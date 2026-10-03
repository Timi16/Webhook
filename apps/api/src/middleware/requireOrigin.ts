import type { RequestHandler } from "express";
import { AppError } from "../lib/errors.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF check for cookie auth: state-changing requests must carry an Origin header equal to
 * the dashboard origin. API-key requests are exempt (a browser cannot forge the header).
 */
export function requireOrigin(dashboardOrigin: string): RequestHandler {
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method) || req.auth?.via === "apiKey") return next();
    if (req.get("origin") !== dashboardOrigin) {
      throw new AppError("FORBIDDEN_ORIGIN", "Origin header does not match the dashboard origin");
    }
    next();
  };
}
