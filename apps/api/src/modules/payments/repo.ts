import type { MatchOutcome, Prisma, PrismaClient } from "@prisma/client";
import type { PageCursor } from "../../lib/pagination.js";

export interface PaymentFilter {
  watchId?: string | undefined;
  wallet?: string | undefined;
  outcome?: MatchOutcome | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

export function createPaymentsRepo(prisma: PrismaClient) {
  // A developer only ever sees payments through matches on their own watches.
  const ownMatches = (developerId: string) =>
    ({ watch: { developerId } }) satisfies Prisma.PaymentMatchWhereInput;

  return {
    list(
      developerId: string,
      filter: PaymentFilter,
      cursor: PageCursor | undefined,
      limit: number,
    ) {
      return prisma.chainPayment.findMany({
        where: {
          matches: {
            some: {
              ...ownMatches(developerId),
              ...(filter.watchId ? { watchId: filter.watchId } : {}),
              ...(filter.outcome ? { outcome: filter.outcome } : {}),
            },
          },
          ...(filter.wallet ? { toAddress: filter.wallet } : {}),
          ...(filter.from || filter.to
            ? {
                ledgerClosedAt: {
                  ...(filter.from ? { gte: filter.from } : {}),
                  ...(filter.to ? { lte: filter.to } : {}),
                },
              }
            : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, eventId: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { eventId: "desc" }],
        take: limit + 1,
        include: {
          matches: {
            where: ownMatches(developerId),
            include: { event: { select: { id: true, type: true } } },
          },
        },
      });
    },

    find(developerId: string, eventId: string) {
      return prisma.chainPayment.findFirst({
        where: { eventId, matches: { some: ownMatches(developerId) } },
        include: {
          matches: {
            where: ownMatches(developerId),
            include: {
              watch: { select: { id: true, label: true } },
              event: {
                select: {
                  id: true,
                  type: true,
                  createdAt: true,
                  deliveries: {
                    select: { id: true, status: true, attemptCount: true, deliveredAt: true },
                  },
                },
              },
            },
          },
        },
      });
    },
  };
}

export type PaymentsRepo = ReturnType<typeof createPaymentsRepo>;
