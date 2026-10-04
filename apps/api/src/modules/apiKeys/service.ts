import type { ApiKey } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { generateApiKey } from "../../lib/ids.js";
import type { ApiKeysRepo } from "./repo.js";

const ROLL_GRACE_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

export interface ApiKeyInput {
  name?: string | undefined;
  note?: string | null | undefined;
  scopes?: string[] | undefined;
  allowedIps?: string[] | undefined;
  /** ISO date-time, or null for a key that never expires. */
  expiresAt?: string | null | undefined;
}

function serialize(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    note: key.note,
    scopes: key.scopes,
    allowedIps: key.allowedIps,
    expiresAt: key.expiresAt?.toISOString() ?? null,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    lastUsedIp: key.lastUsedIp,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Resource not found");
}

/** The settings a create or update may carry, ready for the database. */
function settings(input: ApiKeyInput) {
  let expiresAt: Date | null | undefined;
  if (input.expiresAt !== undefined) {
    expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
    if (expiresAt && expiresAt <= new Date()) {
      throw new AppError("VALIDATION_FAILED", "expiresAt: must_be_in_the_future", {
        details: [{ path: "expiresAt", issue: "must_be_in_the_future" }],
      });
    }
  }
  return {
    ...(input.note !== undefined ? { note: input.note || null } : {}),
    ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
    ...(input.allowedIps !== undefined ? { allowedIps: input.allowedIps } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export function createApiKeysService(repo: ApiKeysRepo, maxApiKeys = 20) {
  return {
    async list(developerId: string) {
      return { data: (await repo.list(developerId)).map(serialize) };
    },

    /** The key with its last 24 hours of use and its most recent requests. */
    async get(developerId: string, id: string) {
      const apiKey = await repo.find(developerId, id);
      if (!apiKey) throw notFound();
      const now = new Date();
      const { hourly, median, recent } = await repo.usage(apiKey.id, now);
      const currentHour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
      const buckets = Array.from({ length: 24 }, (_, i) => {
        const start = currentHour - (23 - i) * HOUR_MS;
        const row = hourly.find((h) => h.hour.getTime() === start);
        return {
          hour: new Date(start).toISOString(),
          requests: row?.requests ?? 0,
          errors: row?.errors ?? 0,
        };
      });
      return {
        apiKey: serialize(apiKey),
        usage: {
          // Totals come from the rows themselves: the oldest hour is only partly inside the window.
          requests: hourly.reduce((sum, h) => sum + h.requests, 0),
          errors: hourly.reduce((sum, h) => sum + h.errors, 0),
          medianMs: median === null ? null : Math.round(median),
          hourly: buckets,
        },
        recentRequests: recent.map((r) => ({
          id: r.id,
          at: r.createdAt.toISOString(),
          method: r.method,
          path: r.path,
          status: r.status,
          durationMs: r.durationMs,
          ip: r.ip,
        })),
      };
    },

    /** The full key is returned only here; only its SHA-256 is stored. */
    async create(developerId: string, input: ApiKeyInput & { name: string }) {
      if ((await repo.countActive(developerId)) >= maxApiKeys) {
        throw new AppError("CONFLICT", `API key limit reached (${maxApiKeys}); revoke one first`);
      }
      const { key, prefix, keyHash } = generateApiKey();
      const apiKey = await repo.create(developerId, {
        name: input.name,
        prefix,
        keyHash,
        ...settings(input),
      });
      return { apiKey: serialize(apiKey), key };
    },

    /** Changes apply to the key's next request. */
    async update(developerId: string, id: string, input: ApiKeyInput) {
      const apiKey = await repo.update(developerId, id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...settings(input),
      });
      if (!apiKey) throw notFound();
      return { apiKey: serialize(apiKey) };
    },

    /**
     * A new key with the same name and settings, shown once. The old key keeps working for 24
     * hours so the new one can be deployed without downtime; its revokedAt holds that end date.
     */
    async roll(developerId: string, id: string) {
      const { key, prefix, keyHash } = generateApiKey();
      const apiKey = await repo.roll(
        developerId,
        id,
        { prefix, keyHash },
        new Date(Date.now() + ROLL_GRACE_MS),
      );
      if (!apiKey) {
        if (await repo.find(developerId, id))
          throw new AppError("CONFLICT", "This key is revoked or expired and can't be rolled");
        throw notFound();
      }
      return { apiKey: serialize(apiKey), key };
    },

    /** Revokes the key; with `permanent`, removes it and its request log as well. */
    async remove(developerId: string, id: string, permanent: boolean): Promise<void> {
      const done = permanent
        ? await repo.remove(developerId, id)
        : await repo.revoke(developerId, id);
      if (!done) throw notFound();
    },
  };
}

export type ApiKeysService = ReturnType<typeof createApiKeysService>;
