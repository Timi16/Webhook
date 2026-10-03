import { PrismaClient } from "@prisma/client";

export type { PrismaClient };

/** Each process creates exactly one client and passes it down. */
export function createPrismaClient(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
