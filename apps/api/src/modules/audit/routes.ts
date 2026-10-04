import type { PrismaClient } from "@prisma/client";
import { auditLogQuerySchema, auditLogResponse } from "@webhook/shared";
import { Router } from "express";
import type { Logger } from "../../lib/logger.js";
import { decodeCursor, toPage } from "../../lib/pagination.js";
import type { Api, AuditEntry } from "../../openapi/registry.js";

/** Writes audit entries. A failure is logged and swallowed: it must never fail the request. */
export function createAuditWriter(prisma: PrismaClient, logger: Logger) {
  /** Endpoints and watches are soft-deleted, so their name can still be read after any change. */
  async function label(entry: AuditEntry): Promise<string | null> {
    if (entry.targetLabel || !entry.targetId) return entry.targetLabel;
    if (entry.action.startsWith("endpoint.")) {
      const endpoint = await prisma.endpoint.findFirst({
        where: { id: entry.targetId, developerId: entry.developerId },
        select: { url: true },
      });
      return endpoint?.url ?? null;
    }
    if (entry.action.startsWith("watch.")) {
      const watch = await prisma.watch.findFirst({
        where: { id: entry.targetId, developerId: entry.developerId },
        select: { label: true, walletAddress: true },
      });
      return watch ? (watch.label ?? watch.walletAddress) : null;
    }
    return null;
  }

  return async (entry: AuditEntry): Promise<void> => {
    try {
      await prisma.auditLog.create({ data: { ...entry, targetLabel: await label(entry) } });
    } catch (err) {
      logger.error({ err, action: entry.action }, "audit log write failed");
    }
  };
}

/** At most this many failed logins are recorded per account per hour. */
const FAILED_LOGINS_PER_HOUR = 20;

/**
 * Puts a wrong-password attempt on the account's record. Capped per hour so that someone
 * guessing passwords cannot bury the rest of the log; the first attempts are what matter.
 */
export function createFailedLoginRecorder(prisma: PrismaClient, logger: Logger) {
  const write = createAuditWriter(prisma, logger);
  return (developerId: string, ip: string | null): void => {
    void (async () => {
      const recent = await prisma.auditLog.count({
        where: {
          developerId,
          action: "account.login_failed",
          createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
      if (recent >= FAILED_LOGINS_PER_HOUR) return;
      await write({
        developerId,
        action: "account.login_failed",
        targetId: null,
        targetLabel: null,
        detail:
          recent + 1 === FAILED_LOGINS_PER_HOUR
            ? "further attempts this hour are not listed"
            : null,
        actor: "session",
        apiKeyId: null,
        ip,
      });
    })().catch((err: unknown) => logger.error({ err }, "failed login could not be recorded"));
  };
}

export function createAuditRouter(api: Api, prisma: PrismaClient): Router {
  const router = Router();

  api(
    router,
    {
      method: "get",
      path: "/v1/audit-log",
      response: auditLogResponse,
      summary: "List account activity",
      description:
        "Every change made to the account, newest first: logins, password and email changes, and each API key, endpoint and watch that was created, changed or deleted, with whether the dashboard or an API key did it and from which IP. Logins are left out unless `logins=true`. Secrets are never recorded.",
      tag: "Auth",
      auth: "session",
      query: auditLogQuerySchema,
    },
    async ({ auth, query }) => {
      const cursor = decodeCursor(query.cursor);
      const rows = await prisma.auditLog.findMany({
        where: {
          developerId: auth.developerId,
          ...(query.kind ? { action: { startsWith: `${query.kind}.` } } : {}),
          ...(query.actor ? { actor: query.actor } : {}),
          ...(query.logins === "true" ? {} : { NOT: { action: "account.logged_in" } }),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      });
      const page = toPage(rows, query.limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
      return {
        data: page.data.map((row) => ({
          id: row.id,
          at: row.createdAt.toISOString(),
          action: row.action,
          targetId: row.targetId,
          targetLabel: row.targetLabel,
          detail: row.detail,
          actor: row.actor === "api_key" ? ("api_key" as const) : ("session" as const),
          apiKeyId: row.apiKeyId,
          ip: row.ip,
        })),
        nextCursor: page.nextCursor,
      };
    },
  );

  return router;
}
