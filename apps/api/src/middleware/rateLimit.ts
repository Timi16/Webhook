import type { RequestHandler } from "express";
import { ipKeyGenerator, rateLimit, type Options } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

const WINDOW_MS = 60_000;

export interface RateLimits {
  /** Per IP on public routes. */
  global: number;
  /** Per IP on /auth POST routes. */
  auth: number;
  /** Per developer on /v1. */
  api: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { global: 60, auth: 5, api: 300 };

// In memory: there is a single API instance.
function limiter(limit: number, extra: Partial<Options> = {}): RequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res, next) => {
      if (!res.getHeader("Retry-After")) res.setHeader("Retry-After", WINDOW_MS / 1000);
      next(new AppError("RATE_LIMITED", "Too many requests, slow down"));
    },
    ...extra,
  });
}

export function createRateLimiters(limits: RateLimits) {
  return {
    /** 60/min per IP on unauthenticated routes; /v1 has its own limits. */
    global: limiter(limits.global, { skip: (req) => req.path.startsWith("/v1/") }),
    /** Unauthenticated /v1 traffic: only failed (401) requests count, per IP. */
    apiPreAuth: limiter(limits.global, {
      requestWasSuccessful: (_req, res) => res.statusCode !== 401,
      skipSuccessfulRequests: true,
    }),
    auth: limiter(limits.auth),
    api: limiter(limits.api, {
      keyGenerator: (req) => req.auth?.developerId ?? ipKeyGenerator(req.ip ?? ""),
    }),
  };
}
