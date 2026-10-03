import type { PrismaClient } from "@prisma/client";

export function createAuthRepo(prisma: PrismaClient) {
  return {
    findDeveloperByEmail: (email: string) => prisma.developer.findUnique({ where: { email } }),
    findDeveloper: (developerId: string) =>
      prisma.developer.findUnique({ where: { id: developerId } }),
    createDeveloper: (data: { email: string; passwordHash: string; name?: string }) =>
      prisma.developer.create({ data }),
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
