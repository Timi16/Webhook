import type { Endpoint } from "@prisma/client";
import type { Env } from "../../config/env.js";
import { buildPingPayload } from "../../delivery/payload.js";
import { assertUrlAllowed, UrlPolicyError, type UrlPolicy } from "../../delivery/safeHttp.js";
import { rotatedSecretFields } from "../../delivery/secrets.js";
import { encryptSecret } from "../../lib/crypto.js";
import { AppError } from "../../lib/errors.js";
import { generateWebhookSecret, newEventId } from "../../lib/ids.js";
import type { EndpointsRepo } from "./repo.js";

const ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;
const TEST_WAIT_MS = 12_000;
const TEST_POLL_MS = 250;

export function serializeEndpoint(e: Endpoint) {
  const rotating = e.prevSecretUntil !== null && e.prevSecretUntil > new Date();
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    status: e.status,
    consecutiveFailures: e.consecutiveFailures,
    disabledReason: e.disabledReason,
    eventTypes: e.eventTypes,
    previousSecretValidUntil: rotating ? (e.prevSecretUntil?.toISOString() ?? null) : null,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

function notFound(): AppError {
  return new AppError("NOT_FOUND", "Resource not found");
}

export interface EndpointsServiceOptions {
  urlPolicy?: UrlPolicy;
  /** How long POST /test waits for the first attempt. */
  testWaitMs?: number;
  maxEndpoints?: number;
}

export function createEndpointsService(
  repo: EndpointsRepo,
  env: Pick<Env, "ENCRYPTION_KEY">,
  options: EndpointsServiceOptions = {},
) {
  const testWaitMs = options.testWaitMs ?? TEST_WAIT_MS;

  /** HTTPS-only and SSRF rules, checked at save time (and again at every send). */
  async function checkUrl(url: string): Promise<string> {
    try {
      return (await assertUrlAllowed(url, options.urlPolicy)).toString();
    } catch (err) {
      if (err instanceof UrlPolicyError) {
        const code = err.code === "UNRESOLVABLE" ? "VALIDATION_FAILED" : err.code;
        throw new AppError(code, err.message, {
          details: [{ path: "url", issue: err.code.toLowerCase() }],
        });
      }
      throw err;
    }
  }

  async function mustFind(developerId: string, id: string): Promise<Endpoint> {
    const endpoint = await repo.find(developerId, id);
    if (!endpoint) throw notFound();
    return endpoint;
  }

  return {
    async list(developerId: string) {
      return { data: (await repo.list(developerId)).map(serializeEndpoint) };
    },

    /** The secret is returned only here; it is stored encrypted. */
    async create(
      developerId: string,
      input: {
        url: string;
        description?: string | null | undefined;
        eventTypes?: string[] | undefined;
      },
    ) {
      const maxEndpoints = options.maxEndpoints ?? 20;
      if ((await repo.count(developerId)) >= maxEndpoints) {
        throw new AppError(
          "CONFLICT",
          `Endpoint limit reached (${maxEndpoints}); delete one first`,
        );
      }
      const url = await checkUrl(input.url);
      const secret = generateWebhookSecret();
      const endpoint = await repo.create(developerId, {
        url,
        description: input.description ?? null,
        ...(input.eventTypes ? { eventTypes: input.eventTypes } : {}),
        secretEnc: encryptSecret(secret, env.ENCRYPTION_KEY),
      });
      return { endpoint: serializeEndpoint(endpoint), secret };
    },

    async get(developerId: string, id: string) {
      const endpoint = await mustFind(developerId, id);
      const { groups, last } = await repo.stats(developerId, id);
      const count = (status: string) => groups.find((g) => g.status === status)?.count ?? 0;
      return {
        endpoint: {
          ...serializeEndpoint(endpoint),
          stats: {
            last24h: {
              delivered: count("DELIVERED"),
              failed: count("FAILED"),
              retrying: count("RETRYING"),
              pending: count("PENDING") + count("SENDING"),
            },
            lastAttempt: last
              ? { at: last.createdAt.toISOString(), statusCode: last.statusCode, error: last.error }
              : null,
          },
        },
      };
    },

    async update(
      developerId: string,
      id: string,
      input: {
        url?: string | undefined;
        description?: string | null | undefined;
        eventTypes?: string[] | undefined;
      },
    ) {
      await mustFind(developerId, id);
      const endpoint = await repo.update(developerId, id, {
        ...(input.url !== undefined ? { url: await checkUrl(input.url) } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      });
      if (!endpoint) throw notFound();
      return { endpoint: serializeEndpoint(endpoint) };
    },

    async remove(developerId: string, id: string): Promise<void> {
      await mustFind(developerId, id);
      if ((await repo.activeWatchCount(developerId, id)) > 0) {
        throw new AppError(
          "CONFLICT",
          "Endpoint is used by active watches; pause or delete them first",
        );
      }
      if (!(await repo.softDelete(developerId, id))) throw notFound();
    },

    /** New secret becomes current; the old one keeps signing alongside it for 24 h. */
    async rotateSecret(developerId: string, id: string) {
      const current = await mustFind(developerId, id);
      const secret = generateWebhookSecret();
      const endpoint = await repo.update(developerId, id, {
        secretEnc: encryptSecret(secret, env.ENCRYPTION_KEY),
        ...rotatedSecretFields(current, new Date(), ROTATION_GRACE_MS),
      });
      if (!endpoint) throw notFound();
      return { secret, previousSecretValidUntil: endpoint.prevSecretUntil?.toISOString() ?? null };
    },

    /** Sends a test.ping and waits up to 12 s for the first attempt. */
    async test(developerId: string, id: string) {
      const endpoint = await mustFind(developerId, id);
      if (endpoint.status === "DISABLED") {
        throw new AppError("CONFLICT", "Endpoint is disabled; enable it before sending a test");
      }
      const eventId = newEventId();
      const createdAt = new Date();
      const type = "test.ping";
      const event = await repo.createEventWithDelivery(developerId, id, {
        id: eventId,
        type,
        payload: buildPingPayload({ eventId, type, createdAt }, id),
        createdAt,
      });
      const deliveryId = event.deliveries[0]?.id;
      const deadline = Date.now() + testWaitMs;
      while (deliveryId && Date.now() < deadline) {
        const attempt = await repo.firstAttempt(developerId, deliveryId);
        if (attempt) {
          return {
            eventId,
            attempt: {
              statusCode: attempt.statusCode,
              durationMs: attempt.durationMs,
              error: attempt.error,
            },
          };
        }
        await new Promise((resolve) => setTimeout(resolve, TEST_POLL_MS));
      }
      // The worker has not picked it up yet; the delivery stays queued.
      return { eventId, attempt: null };
    },

    /** DISABLED -> ACTIVE with the failure counter reset. Nothing is replayed automatically. */
    async enable(developerId: string, id: string) {
      const current = await mustFind(developerId, id);
      if (current.status !== "DISABLED") return { endpoint: serializeEndpoint(current) };
      const endpoint = await repo.update(developerId, id, {
        status: "ACTIVE",
        consecutiveFailures: 0,
        disabledReason: null,
      });
      if (!endpoint) throw notFound();
      return { endpoint: serializeEndpoint(endpoint) };
    },

    async replay(developerId: string, id: string, since: string) {
      await mustFind(developerId, id);
      return { requeued: await repo.replayFailed(developerId, id, new Date(since)) };
    },
  };
}

export type EndpointsService = ReturnType<typeof createEndpointsService>;
