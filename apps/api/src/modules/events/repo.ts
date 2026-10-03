import type { DeliveryStatus, PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../../db/notify.js";
import type { PageCursor } from "../../lib/pagination.js";

export interface EventFilter {
  type?: string | undefined;
  deliveryStatus?: DeliveryStatus | undefined;
  watchId?: string | undefined;
}

export type ResendResult = "not_found" | "sending" | "cancelled" | { deliveryId: string };

export function createEventsRepo(prisma: PrismaClient) {
  return {
    list(developerId: string, filter: EventFilter, cursor: PageCursor | undefined, limit: number) {
      return prisma.webhookEvent.findMany({
        where: {
          developerId,
          ...(filter.type ? { type: filter.type } : {}),
          ...(filter.deliveryStatus
            ? { deliveries: { some: { status: filter.deliveryStatus } } }
            : {}),
          ...(filter.watchId ? { match: { watchId: filter.watchId } } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        include: { deliveries: true, match: { select: { watchId: true, paymentEventId: true } } },
      });
    },

    find(developerId: string, id: string) {
      return prisma.webhookEvent.findFirst({
        where: { id, developerId },
        include: {
          match: { select: { watchId: true, paymentEventId: true } },
          deliveries: { include: { attempts: { orderBy: { number: "asc" } } } },
        },
      });
    },

    /**
     * Resets the event's delivery to PENDING, due now. The same Delivery row is reused, so the
     * Webhook-Id never changes and attempt numbering continues.
     */
    async resend(developerId: string, eventId: string): Promise<ResendResult> {
      return prisma.$transaction(async (tx) => {
        const event = await tx.webhookEvent.findFirst({
          where: { id: eventId, developerId },
          include: { deliveries: true },
        });
        const delivery = event?.deliveries[0];
        if (!event || !delivery) return "not_found";
        // Lock the rows so we never race the dispatcher's claim.
        const locked = await tx.$queryRaw<{ id: string; status: DeliveryStatus; live: boolean }[]>`
          SELECT id, status, ("leaseUntil" IS NOT NULL AND "leaseUntil" > now()) AS live
          FROM "Delivery" WHERE "eventId" = ${eventId} FOR UPDATE`;
        if (locked.some((d) => d.status === "SENDING" && d.live)) return "sending";
        const resendable = locked.filter((d) => d.status !== "CANCELLED").map((d) => d.id);
        if (resendable.length === 0) return "cancelled";
        await tx.delivery.updateMany({
          where: { id: { in: resendable } },
          data: { status: "PENDING", nextAttemptAt: new Date(), leaseUntil: null },
        });
        for (const id of resendable) {
          await notify(tx, CHANNELS.deliveriesUpdated, {
            developerId,
            deliveryId: id,
            eventId,
            status: "PENDING",
          });
        }
        await notify(tx, CHANNELS.deliveries);
        return { deliveryId: resendable[0] ?? delivery.id };
      });
    },

    findDelivery: (developerId: string, id: string) =>
      prisma.delivery.findFirst({ where: { id, event: { developerId } } }),
  };
}

export type EventsRepo = ReturnType<typeof createEventsRepo>;
