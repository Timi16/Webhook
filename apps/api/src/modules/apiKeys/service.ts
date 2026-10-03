import type { ApiKey } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { generateApiKey } from "../../lib/ids.js";
import type { ApiKeysRepo } from "./repo.js";

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

export function createApiKeysService(repo: ApiKeysRepo) {
  return {
    async list(developerId: string) {
      return { data: (await repo.list(developerId)).map(serialize) };
    },
    /** The full key is returned only here; only its SHA-256 is stored. */
    async create(developerId: string, name: string) {
      const { key, prefix, keyHash } = generateApiKey();
      const apiKey = await repo.create(developerId, { name, prefix, keyHash });
      return { apiKey: serialize(apiKey), key };
    },
    async revoke(developerId: string, id: string): Promise<void> {
      if (!(await repo.revoke(developerId, id)))
        throw new AppError("NOT_FOUND", "Resource not found");
    },
  };
}

export type ApiKeysService = ReturnType<typeof createApiKeysService>;
