import { rateLimit } from "express-rate-limit";
import { AppError } from "../lib/errors.js";

const WINDOW_MS = 60_000;

/** 60/min per IP on public routes. In memory: there is a single API instance. */
export function globalRateLimit() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res, next) => {
      if (!res.getHeader("Retry-After")) res.setHeader("Retry-After", WINDOW_MS / 1000);
      next(new AppError("RATE_LIMITED", "Too many requests, slow down"));
    },
  });
}
