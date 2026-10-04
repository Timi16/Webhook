import type { PrismaClient } from "@prisma/client";

export function createAuthRepo(prisma: PrismaClient) {
  return {
    findDeveloperByEmail: (email: string) => prisma.developer.findUnique({ where: { email } }),
    findDeveloper: (developerId: string) =>
      prisma.developer.findUnique({ where: { id: developerId } }),
    createDeveloper: (data: { email: string; passwordHash: string; name?: string }) =>
      prisma.developer.create({ data }),
    setName: (developerId: string, name: string) =>
      prisma.developer.update({ where: { id: developerId }, data: { name } }),

    /**
     * Removes the developer and everything they own. Done in dependency order: several relations
     * are deliberately not cascading (history must not vanish by accident), so each level is
     * deleted explicitly.
     */
    async deleteAccount(developerId: string): Promise<void> {
      await prisma.$transaction(async (tx) => {
        await tx.webhookEvent.deleteMany({ where: { developerId } }); // deliveries and attempts cascade
        await tx.paymentMatch.deleteMany({ where: { watch: { developerId } } });
        // Payments nobody watches any more have no owner left.
        await tx.chainPayment.deleteMany({ where: { matches: { none: {} } } });
        await tx.watch.deleteMany({ where: { developerId } });
        await tx.endpoint.deleteMany({ where: { developerId } });
        await tx.developer.delete({ where: { id: developerId } }); // sessions and API keys cascade
      });
    },

    setPassword: (developerId: string, passwordHash: string) =>
      prisma.developer.update({ where: { id: developerId }, data: { passwordHash } }),
    createSession: (
      developerId: string,
      data: { id: string; expiresAt: Date; ip?: string; userAgent?: string },
    ) => prisma.session.create({ data: { developerId, ...data } }),
    deleteSession: (id: string) => prisma.session.deleteMany({ where: { id } }),
    deleteSessions: (developerId: string, exceptId?: string) =>
      prisma.session.deleteMany({
        where: { developerId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      }),
    deleteExpiredSessions: () =>
      prisma.session.deleteMany({ where: { expiresAt: { lte: new Date() } } }),
  };
}

export type AuthRepo = ReturnType<typeof createAuthRepo>;
