import type { Prisma, PrismaClient } from "@prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_REQUESTS = 20;

export interface ApiKeySettings {
  note?: string | null;
  scopes?: string[];
  allowedIps?: string[];
  expiresAt?: Date | null;
}

export function createApiKeysRepo(prisma: PrismaClient) {
  const find = (developerId: string, id: string) =>
    prisma.apiKey.findFirst({ where: { id, developerId } });
  /** A key counts as active until its revokedAt has passed (a rolled key keeps working for a while). */
  const active = (now: Date) => ({ OR: [{ revokedAt: null }, { revokedAt: { gt: now } }] });

  return {
    find,
    countActive: (developerId: string) =>
      prisma.apiKey.count({ where: { developerId, ...active(new Date()) } }),
    list: (developerId: string) =>
      prisma.apiKey.findMany({ where: { developerId }, orderBy: { createdAt: "desc" } }),
    create: (
      developerId: string,
      data: { name: string; prefix: string; keyHash: string } & ApiKeySettings,
    ) => prisma.apiKey.create({ data: { developerId, ...data } }),

    async update(developerId: string, id: string, data: Prisma.ApiKeyUpdateManyMutationInput) {
      const { count } = await prisma.apiKey.updateMany({ where: { id, developerId }, data });
      return count === 0 ? null : find(developerId, id);
    },

    /** The last 24 hours of the key's request log, and its most recent requests. */
    async usage(apiKeyId: string, now: Date) {
      const from = new Date(now.getTime() - DAY_MS);
      const [hourly, median, recent] = await Promise.all([
        prisma.$queryRaw<{ hour: Date; requests: number; errors: number }[]>`
          SELECT date_trunc('hour', "createdAt") AS hour, count(*)::int AS requests,
                 (count(*) FILTER (WHERE status >= 400))::int AS errors
          FROM "ApiKeyRequest"
          WHERE "apiKeyId" = ${apiKeyId} AND "createdAt" >= ${from}
          GROUP BY 1`,
        prisma.$queryRaw<{ median: number | null }[]>`
          SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS median
          FROM "ApiKeyRequest"
          WHERE "apiKeyId" = ${apiKeyId} AND "createdAt" >= ${from}`,
        prisma.apiKeyRequest.findMany({
          where: { apiKeyId },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: RECENT_REQUESTS,
        }),
      ]);
      return { hourly, median: median[0]?.median ?? null, recent };
    },

    /** Revoked keys are kept for history. False = not found (or not yours). */
    async revoke(developerId: string, id: string): Promise<boolean> {
      const existing = await find(developerId, id);
      if (!existing) return false;
      const now = new Date();
      if (!existing.revokedAt || existing.revokedAt > now) {
        await prisma.apiKey.updateMany({ where: { id, developerId }, data: { revokedAt: now } });
      }
      return true;
    },

    /**
     * Creates the replacement, with the same settings, and gives the old key an end date, in one
     * transaction.
     */
    async roll(
      developerId: string,
      id: string,
      replacement: { prefix: string; keyHash: string },
      oldValidUntil: Date,
    ) {
      return prisma.$transaction(async (tx) => {
        const old = await tx.apiKey.findFirst({ where: { id, developerId } });
        const now = new Date();
        // revokedAt set means revoked, or already rolled and on its way out: rolling it again
        // would push its end date back for ever.
        if (!old || old.revokedAt) return null;
        if (old.expiresAt && old.expiresAt <= now) return null;
        await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: oldValidUntil } });
        return tx.apiKey.create({
          data: {
            developerId,
            name: old.name,
            note: old.note,
            scopes: old.scopes,
            allowedIps: old.allowedIps,
            expiresAt: old.expiresAt,
            ...replacement,
          },
        });
      });
    },

    /** Removes the key and its request log for good. False = not found (or not yours). */
    async remove(developerId: string, id: string): Promise<boolean> {
      const { count } = await prisma.apiKey.deleteMany({ where: { id, developerId } });
      return count > 0;
    },
  };
}

export type ApiKeysRepo = ReturnType<typeof createApiKeysRepo>;
