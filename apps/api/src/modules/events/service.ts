import type { Delivery, DeliveryAttempt, DeliveryStatus } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../../lib/errors.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { EventsRepo } from "./repo.js";

export function serializeDelivery(d: Delivery) {
  return {
    id: d.id,
    endpointId: d.endpointId,
    status: d.status,
    attemptCount: d.attemptCount,
    nextAttemptAt:
      d.status === "PENDING" || d.status === "RETRYING" ? d.nextAttemptAt.toISOString() : null,
    lastStatusCode: d.lastStatusCode,
    lastError: d.lastError,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

function serializeAttempt(a: DeliveryAttempt) {
  return {
    number: a.number,
    startedAt: a.startedAt.toISOString(),
    durationMs: a.durationMs,
    statusCode: a.statusCode,
    error: a.error,
    // Plain text from the developer's endpoint; clients must never render it as HTML.
    responseSnippet: a.responseSnippet,
  };
}

const paymentPayload = z.object({
  data: z.object({
    payment: z.object({
      amount: z.string(),
      asset: z.object({ code: z.string() }),
      from: z.string(),
    }),
    watch: z.object({ label: z.string().nullable() }),
    verification: z.object({ reasons: z.array(z.string()) }),
  }),
});

/** The few payment fields a list needs, read from the frozen payload. */
function summarize(payload: unknown) {
  const parsed = paymentPayload.safeParse(payload);
  if (!parsed.success) return null;
  const { payment, watch, verification } = parsed.data.data;
  return {
    amount: payment.amount,
    assetCode: payment.asset.code,
    from: payment.from,
    watchLabel: watch.label,
    reasons: verification.reasons,
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Resource not found");
}

export function createEventsService(repo: EventsRepo) {
  return {
    async list(
      developerId: string,
      query: {
        type?: string | undefined;
        deliveryStatus?: DeliveryStatus | undefined;
        watchId?: string | undefined;
        cursor?: string | undefined;
        limit: number;
      },
    ) {
      const rows = await repo.list(developerId, query, decodeCursor(query.cursor), query.limit);
      const page = toPage(rows, query.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
      return {
        data: page.data.map((e) => ({
          id: e.id,
          type: e.type,
          createdAt: e.createdAt.toISOString(),
          watchId: e.match?.watchId ?? null,
          paymentId: e.match?.paymentEventId ?? null,
          summary: summarize(e.payload),
          deliveries: e.deliveries.map(serializeDelivery),
        })),
        nextCursor: page.nextCursor,
      };
    },

    async get(developerId: string, id: string) {
      const e = await repo.find(developerId, id);
      if (!e) throw notFound();
      return {
        event: {
          id: e.id,
          type: e.type,
          createdAt: e.createdAt.toISOString(),
          watchId: e.match?.watchId ?? null,
          paymentId: e.match?.paymentEventId ?? null,
          payload: e.payload,
          deliveries: e.deliveries.map((d) => ({
            ...serializeDelivery(d),
            attempts: d.attempts.map(serializeAttempt),
          })),
        },
      };
    },

    async resend(developerId: string, id: string) {
      const result = await repo.resend(developerId, id);
      if (result === "not_found") throw notFound();
      if (result === "sending") throw new AppError("CONFLICT", "This event is already sending");
      if (result === "cancelled") {
        throw new AppError("CONFLICT", "This event's endpoint was deleted, so it cannot be resent");
      }
      const delivery = await repo.findDelivery(developerId, result.deliveryId);
      if (!delivery) throw notFound();
      return { delivery: serializeDelivery(delivery) };
    },
  };
}

export type EventsService = ReturnType<typeof createEventsService>;
