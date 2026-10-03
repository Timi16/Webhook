import type { Prisma, PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../../db/notify.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const REPLAY_LIMIT = 1_000;

export function createEndpointsRepo(prisma: PrismaClient) {
  const find = (developerId: string, id: string) =>
    prisma.endpoint.findFirst({ where: { id, developerId, deletedAt: null } });

  return {
    find,
    count: (developerId: string) =>
      prisma.endpoint.count({ where: { developerId, deletedAt: null } }),
    list: (developerId: string) =>
      prisma.endpoint.findMany({
        where: { developerId, deletedAt: null },
        orderBy: { createdAt: "desc" },
      }),

    create: (
      developerId: string,
      data: { url: string; description: string | null; secretEnc: string },
    ) => prisma.endpoint.create({ data: { developerId, ...data } }),

    async update(developerId: string, id: string, data: Prisma.EndpointUpdateManyMutationInput) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.endpoint.updateMany({
          where: { id, developerId, deletedAt: null },
          data,
        });
        if (count === 0) return null;
        const endpoint = await tx.endpoint.findFirstOrThrow({ where: { id, developerId } });
        await notify(tx, CHANNELS.endpointsUpdated, {
          developerId,
          endpointId: id,
          status: endpoint.status,
        });
        return endpoint;
      });
    },

    /** Delivery counts by status over the last 24 h. */
    async stats(developerId: string, id: string) {
      const groups = await prisma.delivery.groupBy({
        by: ["status"],
        where: {
          endpointId: id,
          endpoint: { developerId },
          updatedAt: { gte: new Date(Date.now() - DAY_MS) },
        },
        _count: { _all: true },
      });
      const last = await prisma.deliveryAttempt.findFirst({
        where: { delivery: { endpointId: id, endpoint: { developerId } } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true, statusCode: true, error: true },
      });
      return { groups: groups.map((g) => ({ status: g.status, count: g._count._all })), last };
    },

    activeWatchCount: (developerId: string, endpointId: string) =>
      prisma.watch.count({ where: { developerId, endpointId, active: true, deletedAt: null } }),

    /** Soft delete: the row stays for history, unfinished deliveries become CANCELLED. */
    async softDelete(developerId: string, id: string): Promise<boolean> {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.endpoint.updateMany({
          where: { id, developerId, deletedAt: null },
          data: { deletedAt: new Date(), status: "DISABLED", disabledReason: "DELETED" },
        });
        if (count === 0) return false;
        const cancelled = await tx.delivery.findMany({
          where: { endpointId: id, status: { in: ["PENDING", "RETRYING", "SENDING"] } },
          select: { id: true, eventId: true },
        });
        await tx.delivery.updateMany({
          where: { id: { in: cancelled.map((d) => d.id) } },
          data: { status: "CANCELLED", leaseUntil: null },
        });
        for (const d of cancelled) {
          await notify(tx, CHANNELS.deliveriesUpdated, {
            developerId,
            deliveryId: d.id,
            eventId: d.eventId,
            status: "CANCELLED",
          });
        }
        await notify(tx, CHANNELS.endpointsUpdated, {
          developerId,
          endpointId: id,
          status: "DELETED",
        });
        return true;
      });
    },

    /** Creates an event with one delivery due now and wakes the dispatcher. */
    async createEventWithDelivery(
      developerId: string,
      endpointId: string,
      event: { id: string; type: string; payload: Prisma.InputJsonObject; createdAt: Date },
    ) {
      return prisma.$transaction(async (tx) => {
        const created = await tx.webhookEvent.create({
          data: {
            ...event,
            developerId,
            deliveries: { create: { endpointId, nextAttemptAt: event.createdAt } },
          },
          include: { deliveries: true },
        });
        await notify(tx, CHANNELS.deliveries);
        return created;
      });
    },

    firstAttempt: (developerId: string, deliveryId: string) =>
      prisma.deliveryAttempt.findFirst({
        where: { deliveryId, number: 1, delivery: { endpoint: { developerId } } },
      }),

    /** Resets up to 1,000 FAILED deliveries created since `since` to PENDING, due now. */
    async replayFailed(developerId: string, endpointId: string, since: Date): Promise<number> {
      return prisma.$transaction(async (tx) => {
        const failed = await tx.delivery.findMany({
          where: {
            endpointId,
            endpoint: { developerId },
            status: "FAILED",
            createdAt: { gte: since },
          },
          orderBy: { createdAt: "asc" },
          take: REPLAY_LIMIT,
          select: { id: true },
        });
        if (failed.length === 0) return 0;
        const { count } = await tx.delivery.updateMany({
          where: { id: { in: failed.map((d) => d.id) }, status: "FAILED" },
          data: { status: "PENDING", nextAttemptAt: new Date(), leaseUntil: null },
        });
        await notify(tx, CHANNELS.deliveries);
        return count;
      });
    },
  };
}

export type EndpointsRepo = ReturnType<typeof createEndpointsRepo>;
