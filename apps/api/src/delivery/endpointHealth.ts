import type { Prisma } from "@prisma/client";
import { MAX_ATTEMPTS } from "./schedule.js";

export const DISABLE_AFTER_FAILED_EVENTS = 20;

export type AttemptClass = "delivered" | "gone" | "retry" | "exhausted";

export function classifyAttempt(statusCode: number | null, attempt: number): AttemptClass {
  if (statusCode !== null && statusCode >= 200 && statusCode < 300) return "delivered";
  if (statusCode === 410) return "gone";
  return attempt < MAX_ATTEMPTS ? "retry" : "exhausted";
}

export interface EndpointChange {
  status: "ACTIVE" | "FAILING" | "DISABLED";
  disabledReason: "GONE" | "TOO_MANY_FAILURES" | null;
}

/**
 * Applies an attempt's effect on its endpoint inside transaction B. Returns the new status when
 * it changed. A DISABLED (or deleted) endpoint is never re-activated by a late result.
 *
 * ACTIVE -> FAILING on any failed attempt · FAILING -> ACTIVE on any 2xx ·
 * -> DISABLED on a 410, or when 20 events in a row end FAILED.
 */
export async function applyEndpointEffect(
  tx: Prisma.TransactionClient,
  endpointId: string,
  outcome: AttemptClass,
  attempt: number,
): Promise<EndpointChange | null> {
  switch (outcome) {
    case "delivered": {
      const { count } = await tx.endpoint.updateMany({
        where: { id: endpointId, status: "FAILING" },
        data: { status: "ACTIVE", consecutiveFailures: 0 },
      });
      await tx.endpoint.updateMany({
        where: { id: endpointId, status: "ACTIVE", consecutiveFailures: { gt: 0 } },
        data: { consecutiveFailures: 0 },
      });
      return count > 0 ? { status: "ACTIVE", disabledReason: null } : null;
    }
    case "gone": {
      const { count } = await tx.endpoint.updateMany({
        where: { id: endpointId, status: { not: "DISABLED" } },
        data: { status: "DISABLED", disabledReason: "GONE" },
      });
      return count > 0 ? { status: "DISABLED", disabledReason: "GONE" } : null;
    }
    case "retry": {
      const { count } = await tx.endpoint.updateMany({
        where: { id: endpointId, status: "ACTIVE" },
        data: { status: "FAILING" },
      });
      return count > 0 ? { status: "FAILING", disabledReason: null } : null;
    }
    case "exhausted": {
      // consecutiveFailures counts failed EVENTS: only the 10th attempt counts, not later resends.
      if (attempt !== MAX_ATTEMPTS) return null;
      const { count } = await tx.endpoint.updateMany({
        where: { id: endpointId, status: { not: "DISABLED" } },
        data: { consecutiveFailures: { increment: 1 } },
      });
      if (count === 0) return null;
      const endpoint = await tx.endpoint.findUniqueOrThrow({ where: { id: endpointId } });
      if (endpoint.consecutiveFailures >= DISABLE_AFTER_FAILED_EVENTS) {
        await tx.endpoint.update({
          where: { id: endpointId },
          data: { status: "DISABLED", disabledReason: "TOO_MANY_FAILURES" },
        });
        return { status: "DISABLED", disabledReason: "TOO_MANY_FAILURES" };
      }
      if (endpoint.status === "ACTIVE") {
        await tx.endpoint.update({ where: { id: endpointId }, data: { status: "FAILING" } });
        return { status: "FAILING", disabledReason: null };
      }
      return null;
    }
  }
}
