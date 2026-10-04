import type { PrismaClient } from "@prisma/client";

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
    create: (developerId: string, data: { name: string; prefix: string; keyHash: string }) =>
      prisma.apiKey.create({ data: { developerId, ...data } }),

    async rename(developerId: string, id: string, name: string) {
      const { count } = await prisma.apiKey.updateMany({
        where: { id, developerId },
        data: { name },
      });
      return count === 0 ? null : find(developerId, id);
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

    /** Creates the replacement and gives the old key an end date, in one transaction. */
    async roll(
      developerId: string,
      id: string,
      replacement: { prefix: string; keyHash: string },
      oldValidUntil: Date,
    ) {
      return prisma.$transaction(async (tx) => {
        const old = await tx.apiKey.findFirst({ where: { id, developerId } });
        if (!old || (old.revokedAt && old.revokedAt <= new Date())) return null;
        await tx.apiKey.update({ where: { id: old.id }, data: { revokedAt: oldValidUntil } });
        return tx.apiKey.create({ data: { developerId, name: old.name, ...replacement } });
      });
    },

    /** Removes the key for good. False = not found (or not yours). */
    async remove(developerId: string, id: string): Promise<boolean> {
      const { count } = await prisma.apiKey.deleteMany({ where: { id, developerId } });
      return count > 0;
    },
  };
}

export type ApiKeysRepo = ReturnType<typeof createApiKeysRepo>;
