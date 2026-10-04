import type { PrismaClient } from "@prisma/client";

const HOUR_MS = 60 * 60 * 1000;

export function createOverviewRepo(prisma: PrismaClient) {
  return {
    /** Everything the dashboard's overview shows for one developer, for the last `hours` hours. */
    async summary(developerId: string, hours: number, now: Date) {
      const from = new Date(now.getTime() - hours * HOUR_MS);
      const previousFrom = new Date(from.getTime() - hours * HOUR_MS);

      const [outcomes, previous, deliveries, durations, watches, hourly] = await Promise.all([
        prisma.$queryRaw<{ outcome: string; matches: number; payments: number }[]>`
          SELECT m.outcome::text AS outcome, count(*)::int AS matches,
                 count(DISTINCT m."paymentEventId")::int AS payments
          FROM "PaymentMatch" m JOIN "Watch" w ON w.id = m."watchId"
          WHERE w."developerId" = ${developerId} AND m."createdAt" >= ${from}
          GROUP BY m.outcome`,
        prisma.$queryRaw<{ payments: number }[]>`
          SELECT count(DISTINCT m."paymentEventId")::int AS payments
          FROM "PaymentMatch" m JOIN "Watch" w ON w.id = m."watchId"
          WHERE w."developerId" = ${developerId}
            AND m."createdAt" >= ${previousFrom} AND m."createdAt" < ${from}`,
        prisma.$queryRaw<{ status: string; count: number }[]>`
          SELECT d.status::text AS status, count(*)::int AS count
          FROM "Delivery" d JOIN "WebhookEvent" e ON e.id = d."eventId"
          WHERE e."developerId" = ${developerId} AND e."createdAt" >= ${from}
          GROUP BY d.status`,
        prisma.$queryRaw<{ median: number | null; p95: number | null }[]>`
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY a."durationMs") AS median,
                 percentile_cont(0.95) WITHIN GROUP (ORDER BY a."durationMs") AS p95
          FROM "DeliveryAttempt" a
          JOIN "Delivery" d ON d.id = a."deliveryId"
          JOIN "WebhookEvent" e ON e.id = d."eventId"
          WHERE e."developerId" = ${developerId} AND a."createdAt" >= ${from}
            AND a."statusCode" BETWEEN 200 AND 299`,
        prisma.watch.groupBy({
          by: ["active"],
          where: { developerId, deletedAt: null },
          _count: { _all: true },
        }),
        prisma.$queryRaw<{ hour: Date; outcome: string; count: number }[]>`
          SELECT date_trunc('hour', m."createdAt") AS hour, m.outcome::text AS outcome, count(*)::int AS count
          FROM "PaymentMatch" m JOIN "Watch" w ON w.id = m."watchId"
          WHERE w."developerId" = ${developerId} AND m."createdAt" >= ${from}
          GROUP BY 1, 2`,
      ]);
      return { from, outcomes, previous, deliveries, durations, watches, hourly };
    },
  };
}

export type OverviewRepo = ReturnType<typeof createOverviewRepo>;
