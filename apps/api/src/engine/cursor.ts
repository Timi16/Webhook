import type { Prisma, PrismaClient } from "@prisma/client";
import type { EventCursor } from "./types.js";

export const RPC_CURSOR_NAME = "rpc-events";

type Db = PrismaClient | Prisma.TransactionClient;

export async function loadCursor(db: Db): Promise<EventCursor | null> {
  const row = await db.cursor.findUnique({ where: { name: RPC_CURSOR_NAME } });
  if (!row) return null;
  return { ledger: row.ledger, ...(row.pagingToken ? { pagingToken: row.pagingToken } : {}) };
}

/**
 * Changes at every testnet reset. Event IDs are derived from ledger positions, which start
 * over after a reset, so IDs from the new network are prefixed with this to keep them apart
 * from rows recorded on the old one.
 */
export async function loadNetworkGeneration(db: Db): Promise<string | null> {
  const row = await db.cursor.findUnique({
    where: { name: RPC_CURSOR_NAME },
    select: { lastNetworkResetAt: true },
  });
  return row?.lastNetworkResetAt
    ? Math.floor(row.lastNetworkResetAt.getTime() / 1000).toString(36)
    : null;
}

export function tagPayment<T extends { eventId: string }>(
  payment: T,
  generation: string | null,
): T {
  return generation ? { ...payment, eventId: `r${generation}-${payment.eventId}` } : payment;
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
