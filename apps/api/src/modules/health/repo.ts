import type { PrismaClient } from "../../db/prisma.js";

export const RPC_CURSOR_NAME = "rpc-events";

export interface HealthSnapshot {
  cursor: { ledger: number; updatedAt: Date } | null;
  dueDeliveries: number;
}

export interface HealthRepo {
  snapshot(now: Date): Promise<HealthSnapshot>;
}

export function createHealthRepo(prisma: PrismaClient): HealthRepo {
  return {
    async snapshot(now) {
      const [cursor, dueDeliveries] = await Promise.all([
        prisma.cursor.findUnique({
          where: { name: RPC_CURSOR_NAME },
          select: { ledger: true, updatedAt: true },
        }),
        prisma.delivery.count({
          where: { status: { in: ["PENDING", "RETRYING"] }, nextAttemptAt: { lte: now } },
        }),
      ]);
      return { cursor, dueDeliveries };
    },
  };
}
