import type { Prisma, PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../../db/notify.js";
import { RPC_CURSOR_NAME } from "../../engine/cursor.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function createWatchesRepo(prisma: PrismaClient) {
  const find = (developerId: string, id: string) =>
    prisma.watch.findFirst({ where: { id, developerId, deletedAt: null } });

  return {
    find,
    list: (
      developerId: string,
      filter: { wallet?: string | undefined; active?: boolean | undefined },
    ) =>
      prisma.watch.findMany({
        where: {
          developerId,
          deletedAt: null,
          ...(filter.wallet ? { walletAddress: filter.wallet } : {}),
          ...(filter.active !== undefined ? { active: filter.active } : {}),
        },
        orderBy: { createdAt: "desc" },
      }),

    count: (developerId: string) => prisma.watch.count({ where: { developerId, deletedAt: null } }),

    endpointExists: async (developerId: string, endpointId: string) =>
      (await prisma.endpoint.count({ where: { id: endpointId, developerId, deletedAt: null } })) >
      0,

    /** Every write tells the worker to reload its watched set. */
    async create(developerId: string, data: Omit<Prisma.WatchUncheckedCreateInput, "developerId">) {
      return prisma.$transaction(async (tx) => {
        const watch = await tx.watch.create({ data: { ...data, developerId } });
        await notify(tx, CHANNELS.watchesChanged);
        return watch;
      });
    },

    async update(developerId: string, id: string, data: Prisma.WatchUncheckedUpdateManyInput) {
      return prisma.$transaction(async (tx) => {
        const { count } = await tx.watch.updateMany({
          where: { id, developerId, deletedAt: null },
          data,
        });
        if (count === 0) return null;
        await notify(tx, CHANNELS.watchesChanged);
        return tx.watch.findFirstOrThrow({ where: { id, developerId } });
      });
    },

    async stats(developerId: string, watchId: string) {
      const groups = await prisma.paymentMatch.groupBy({
        by: ["outcome"],
        where: {
          watchId,
          watch: { developerId },
          createdAt: { gte: new Date(Date.now() - DAY_MS) },
        },
        _count: { _all: true },
      });
      const count = (outcome: string) =>
        groups.find((g) => g.outcome === outcome)?._count._all ?? 0;
      return { verified24h: count("VERIFIED"), rejected24h: count("REJECTED") };
    },

    /** Last ledger the worker has processed, if it has ever run. Not tenant data. */
    cursor: () =>
      prisma.cursor.findUnique({
        where: { name: RPC_CURSOR_NAME },
        select: { ledger: true, updatedAt: true },
      }),
  };
}

export type WatchesRepo = ReturnType<typeof createWatchesRepo>;
