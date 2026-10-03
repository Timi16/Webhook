import { z } from "zod";

export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "SECRET_KEY_REJECTED",
  "INSECURE_URL",
  "SSRF_BLOCKED",
  "UNAUTHENTICATED",
  "FORBIDDEN_ORIGIN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorDetailSchema = z.object({
  path: z.string(),
  issue: z.string(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
