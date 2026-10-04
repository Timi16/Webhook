import type { PrismaClient } from "@prisma/client";
import { RPC_CURSOR_NAME } from "../health/repo.js";

export type CheckResult = "ok" | "degraded" | "down";
export const COMPONENT_KEYS = ["api", "detection", "delivery"] as const;
export type ComponentKey = (typeof COMPONENT_KEYS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;
/** Rows older than this are dropped; the page shows 90 days. */
const KEEP_DAYS = 120;

/** Midnight UTC of the day `at` falls in. */
export function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

export function createStatusRepo(prisma: PrismaClient) {
  return {
    /** How old the ingestion cursor is and how long the oldest due delivery has waited, in ms. */
    async live(now: Date) {
      const [cursor, oldestDue] = await Promise.all([
        prisma.cursor.findUnique({
          where: { name: RPC_CURSOR_NAME },
          select: { updatedAt: true },
        }),
        prisma.delivery.findFirst({
          where: {
            status: { in: ["PENDING", "RETRYING"] },
            nextAttemptAt: { lte: now },
            // Deliveries parked behind a DISABLED endpoint are never claimed, so they are not late.
            endpoint: { status: { not: "DISABLED" } },
          },
          orderBy: { nextAttemptAt: "asc" },
          select: { nextAttemptAt: true },
        }),
      ]);
      return {
        cursorAgeMs: cursor ? now.getTime() - cursor.updatedAt.getTime() : null,
        oldestDueMs: oldestDue ? now.getTime() - oldestDue.nextAttemptAt.getTime() : null,
      };
    },

    /** Adds one check per component to today's counts. */
    async record(sample: Record<ComponentKey, CheckResult>, now: Date): Promise<void> {
      const day = utcDay(now);
      await prisma.$transaction(
        COMPONENT_KEYS.map((component) => {
          const result = sample[component];
          const ok = result === "ok" ? 1 : 0;
          const degraded = result === "degraded" ? 1 : 0;
          const down = result === "down" ? 1 : 0;
          return prisma.$executeRaw`
            INSERT INTO "StatusDay" (day, component, ok, degraded, down)
            VALUES (${day}::date, ${component}, ${ok}, ${degraded}, ${down})
            ON CONFLICT (day, component) DO UPDATE SET
              ok = "StatusDay".ok + EXCLUDED.ok,
              degraded = "StatusDay".degraded + EXCLUDED.degraded,
              down = "StatusDay".down + EXCLUDED.down`;
        }),
      );
    },

    prune: (now: Date) =>
      prisma.statusDay.deleteMany({
        where: { day: { lt: new Date(utcDay(now).getTime() - KEEP_DAYS * DAY_MS) } },
      }),

    history: (from: Date) =>
      prisma.statusDay.findMany({ where: { day: { gte: from } }, orderBy: { day: "asc" } }),
  };
}

export type StatusRepo = ReturnType<typeof createStatusRepo>;
