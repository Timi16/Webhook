import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import pg from "pg";
import { inject } from "vitest";
import { createPrismaClient } from "../../src/db/prisma.js";

export interface TestDb {
  url: string;
  prisma: PrismaClient;
  cleanup: () => Promise<void>;
}

/** A private, fully migrated database per test file, cloned from the template. */
export async function createTestDb(): Promise<TestDb> {
  const name = `test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: inject("adminUrl") });
  await admin.connect();
  try {
    // Cloning takes a brief exclusive lock on the template; retry if another file is cloning.
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${inject("templateDb")}"`);
        break;
      } catch (err) {
        if (attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  } finally {
    await admin.end();
  }
  const url = new URL(inject("adminUrl"));
  url.pathname = `/${name}`;
  const prisma = createPrismaClient(url.toString());
  return {
    url: url.toString(),
    prisma,
    cleanup: async () => {
      await prisma.$disconnect();
    },
  };
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  { timeoutMs = 5_000, intervalMs = 25 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
