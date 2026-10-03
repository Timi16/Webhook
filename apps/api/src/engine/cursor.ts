import type { Prisma, PrismaClient } from "@prisma/client";
import type { EventCursor } from "./types.js";

export const RPC_CURSOR_NAME = "rpc-events";

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadCursor(db: Db): Promise<EventCursor | null> {
  const row = await db.cursor.findUnique({ where: { name: RPC_CURSOR_NAME } });
  if (!row) return null;
  return { ledger: row.ledger, ...(row.pagingToken ? { pagingToken: row.pagingToken } : {}) };
}

export async function saveCursor(
  db: Db,
  cursor: EventCursor,
  networkPassphrase: string,
): Promise<void> {
  const data = {
    ledger: cursor.ledger,
    pagingToken: cursor.pagingToken ?? null,
    networkPassphrase,
  };
  await db.cursor.upsert({
    where: { name: RPC_CURSOR_NAME },
    create: { name: RPC_CURSOR_NAME, ...data },
    update: data,
  });
}
