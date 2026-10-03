import type { ErrorResponse } from "@webhook/shared";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError("NOT_FOUND", "Resource not found"));
};

function bodyParserErrorType(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "type" in err && typeof err.type === "string") {
    return err.type;
  }
  return undefined;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  switch (bodyParserErrorType(err)) {
    case "entity.parse.failed":
      return new AppError("VALIDATION_FAILED", "Request body is not valid JSON");
    case "entity.too.large":
      return new AppError("VALIDATION_FAILED", "Request body is too large", { status: 413 });
    default:
      break;
  }
  // Express and body-parser signal other client mistakes (bad percent-encoding, unsupported
  // charset, aborted body) with a 4xx status on the error.
  if (typeof err === "object" && err !== null && "status" in err) {
    const status = err.status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return new AppError("VALIDATION_FAILED", "Malformed request", { status });
    }
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  const known = toAppError(err);
  if (!known) req.log.error({ err }, "unhandled error");

  const appError = known ?? new AppError("INTERNAL", "Something went wrong");
  const body: ErrorResponse = {
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details ? { details: appError.details } : {}),
      requestId: String(req.id),
    },
  };
  res.status(appError.status).json(body);
};
