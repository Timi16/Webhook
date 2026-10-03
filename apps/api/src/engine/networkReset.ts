import type { PrismaClient } from "@prisma/client";
import { CHANNELS, notify } from "../db/notify.js";
import { buildNetworkResetPayload } from "../delivery/payload.js";
import type { Alerter } from "../lib/alert.js";
import { newEventId } from "../lib/ids.js";
import type { Logger } from "../lib/logger.js";
import { RPC_CURSOR_NAME } from "./cursor.js";

export interface NetworkResetDeps {
  prisma: PrismaClient;
  networkPassphrase: string;
  alert: Alerter;
  logger: Logger;
}

/**
 * Testnet was reset (the tip ledger dropped far below the cursor): move the cursor to the new
 * tip and tell every active endpoint, all in one transaction.
 */
export async function handleNetworkReset(
  deps: NetworkResetDeps,
  tip: number,
  now = new Date(),
): Promise<void> {
  const notified = await deps.prisma.$transaction(async (tx) => {
    await tx.cursor.upsert({
      where: { name: RPC_CURSOR_NAME },
      create: {
        name: RPC_CURSOR_NAME,
        ledger: tip,
        networkPassphrase: deps.networkPassphrase,
        lastNetworkResetAt: now,
      },
      update: { ledger: tip, pagingToken: null, lastNetworkResetAt: now },
    });

    const endpoints = await tx.endpoint.findMany({
      where: { status: { not: "DISABLED" } },
      select: { id: true, developerId: true },
    });
    for (const endpoint of endpoints) {
      const eventId = newEventId();
      const type = "system.network_reset";
      await tx.webhookEvent.create({
        data: {
          id: eventId,
          developerId: endpoint.developerId,
          type,
          payload: buildNetworkResetPayload({ eventId, type, createdAt: now }, tip),
          createdAt: now,
          deliveries: { create: { endpointId: endpoint.id, nextAttemptAt: now } },
        },
      });
      await notify(tx, CHANNELS.notices, {
        developerId: endpoint.developerId,
        kind: "NETWORK_RESET",
      });
    }
    if (endpoints.length > 0) await notify(tx, CHANNELS.deliveries);
    return endpoints.length;
  });

  deps.logger.warn({ tip, notified }, "testnet reset detected, cursor moved to the new tip");
  await deps.alert(
    `Testnet reset detected. Cursor moved to ledger ${tip}; ${notified} endpoint(s) notified.`,
  );
}
