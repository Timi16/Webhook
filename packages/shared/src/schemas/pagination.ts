import { z } from "zod";
import { walletAddressSchema } from "./watch.js";

export const paginationQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
};

const isoDate = z.iso.datetime({ offset: true });

export const listPaymentsQuerySchema = z.strictObject({
  watchId: z.string().min(1).max(64).optional(),
  wallet: walletAddressSchema.optional(),
  outcome: z.enum(["VERIFIED", "REJECTED"]).optional(),
  asset: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}$/)
    .optional()
    .describe("Asset code, e.g. USDC or XLM"),
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Matches the start of a transaction hash or address, or part of a memo"),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...paginationQuery,
});

export const DELIVERY_STATUSES = [
  "PENDING",
  "SENDING",
  "DELIVERED",
  "RETRYING",
  "FAILED",
  "CANCELLED",
] as const;

export const listEventsQuerySchema = z.strictObject({
  type: z
    .enum(["payment.received", "payment.rejected", "test.ping", "system.network_reset"])
    .optional(),
  deliveryStatus: z.enum(DELIVERY_STATUSES).optional(),
  watchId: z.string().min(1).max(64).optional(),
  endpointId: z.string().min(1).max(64).optional(),
  q: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Matches the start of an event ID or payment ID"),
  ...paginationQuery,
});

export const listWatchesQuerySchema = z.strictObject({
  wallet: walletAddressSchema.optional(),
  active: z.enum(["true", "false"]).optional(),
});

export const idParamSchema = z.strictObject({ id: z.string().min(1).max(64) });
export const eventIdParamSchema = z.strictObject({ eventId: z.string().min(1).max(128) });

export const addressParamSchema = z.strictObject({ address: walletAddressSchema });
