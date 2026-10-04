import type { ApiKey } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { generateApiKey } from "../../lib/ids.js";
import type { ApiKeysRepo } from "./repo.js";

const ROLL_GRACE_MS = 24 * 60 * 60 * 1000;

function serialize(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Resource not found");
}

export function createApiKeysService(repo: ApiKeysRepo, maxApiKeys = 20) {
  return {
    async list(developerId: string) {
      return { data: (await repo.list(developerId)).map(serialize) };
    },

    /** The full key is returned only here; only its SHA-256 is stored. */
    async create(developerId: string, name: string) {
      if ((await repo.countActive(developerId)) >= maxApiKeys) {
        throw new AppError("CONFLICT", `API key limit reached (${maxApiKeys}); revoke one first`);
      }
      const { key, prefix, keyHash } = generateApiKey();
      const apiKey = await repo.create(developerId, { name, prefix, keyHash });
      return { apiKey: serialize(apiKey), key };
    },

    async rename(developerId: string, id: string, name: string) {
      const apiKey = await repo.rename(developerId, id, name);
      if (!apiKey) throw notFound();
      return { apiKey: serialize(apiKey) };
    },

    /**
     * A new key with the same name, shown once. The old key keeps working for 24 hours so the
     * new one can be deployed without downtime; its revokedAt holds that end date.
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
          throw new AppError("CONFLICT", "This key is revoked and can't be rolled");
        throw notFound();
      }
      return { apiKey: serialize(apiKey), key };
    },

    /** Revokes the key; with `permanent`, removes it from the account as well. */
    async remove(developerId: string, id: string, permanent: boolean): Promise<void> {
      const done = permanent
        ? await repo.remove(developerId, id)
        : await repo.revoke(developerId, id);
      if (!done) throw notFound();
    },
  };
}

export type ApiKeysService = ReturnType<typeof createApiKeysService>;
