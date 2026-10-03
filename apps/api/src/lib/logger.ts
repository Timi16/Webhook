import { pino, type Logger } from "pino";
import type { Env } from "../config/env.js";

export type { Logger };

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.password",
  "*.secret",
  "*.apiKey",
];

export function createLogger(env: Pick<Env, "NODE_ENV" | "LOG_LEVEL">): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
    ...(env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
  });
}
