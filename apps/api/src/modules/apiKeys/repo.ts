import type { PrismaClient } from "@prisma/client";

export function createApiKeysRepo(prisma: PrismaClient) {
  return {
    countActive: (developerId: string) =>
      prisma.apiKey.count({ where: { developerId, revokedAt: null } }),
    list: (developerId: string) =>
      prisma.apiKey.findMany({ where: { developerId }, orderBy: { createdAt: "desc" } }),
    create: (developerId: string, data: { name: string; prefix: string; keyHash: string }) =>
      prisma.apiKey.create({ data: { developerId, ...data } }),
    /** Revoked keys are kept for history. Returns how many rows changed (0 = not found / not yours). */
    revoke: async (developerId: string, id: string) => {
      const existing = await prisma.apiKey.findFirst({ where: { id, developerId } });
      if (!existing) return false;
      if (!existing.revokedAt) {
        await prisma.apiKey.updateMany({
          where: { id, developerId },
          data: { revokedAt: new Date() },
        });
      }
      return true;
    },
  };
}

export type ApiKeysRepo = ReturnType<typeof createApiKeysRepo>;
