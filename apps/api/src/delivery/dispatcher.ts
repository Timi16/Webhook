import type { PrismaClient } from "@prisma/client";
import type { Env } from "../config/env.js";
import { CHANNELS, notify } from "../db/notify.js";
import { decryptSecret } from "../lib/crypto.js";
import type { Logger } from "../lib/logger.js";
import type { Mailer } from "../lib/mailer.js";
import { applyEndpointEffect, classifyAttempt, type EndpointChange } from "./endpointHealth.js";
import type { HttpResult, SafeHttpClient } from "./safeHttp.js";
import { previousSecrets } from "./secrets.js";
import { nextDelayMs } from "./schedule.js";
import { buildHeaders } from "./signer.js";

const POLL_INTERVAL_MS = 1_000;

export interface DispatcherDeps {
  prisma: PrismaClient;
  http: SafeHttpClient;
  env: Pick<Env, "ENCRYPTION_KEY">;
  logger: Logger;
  mailer: Mailer;
  /** Sends in flight overall. */
  maxInFlight?: number;
  /** Sends in flight per endpoint. */
  perEndpoint?: number;
  /** Sends in flight per developer, across all their endpoints. */
  perDeveloper?: number;
  leaseSeconds?: number;
  random?: () => number;
}

interface Claimed {
  id: string;
  eventId: string;
  endpointId: string;
  attemptCount: number;
}

/**
 * Claims due deliveries from Postgres, sends each through the SSRF-safe client and records
 * the result. At-least-once: a crash after the send but before the record means the lease
 * expires and the delivery is sent again with the same Webhook-Id.
 */
export class Dispatcher {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly maxInFlight: number;
  private readonly perEndpoint: number;
  private readonly perDeveloper: number;
  private readonly leaseSeconds: number;
  private wakeUp: (() => void) | undefined;

  constructor(private readonly deps: DispatcherDeps) {
    this.maxInFlight = deps.maxInFlight ?? 20;
    this.perEndpoint = deps.perEndpoint ?? 5;
    this.perDeveloper = deps.perDeveloper ?? 10;
    this.leaseSeconds = deps.leaseSeconds ?? 60;
  }

  /** Wakes the loop early (LISTEN deliveries, or a send slot freeing up). */
  wake(): void {
    this.wakeUp?.();
  }

  /** Runs until aborted: wake on notify, poll every 1 s as a fallback. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick();
      } catch (err) {
        this.deps.logger.error({ err }, "dispatcher pass failed");
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          this.wakeUp = undefined;
          resolve();
        };
        const timer = setTimeout(done, POLL_INTERVAL_MS);
        this.wakeUp = done;
        signal.addEventListener("abort", done, { once: true });
      });
    }
  }

  /** Claims as many due deliveries as there are free slots and starts sending them. */
  async tick(): Promise<number> {
    const free = this.maxInFlight - this.inFlight.size;
    if (free <= 0) return 0;
    const claimed = await this.claim(free);
    for (const row of claimed) {
      const send: Promise<void> = this.deliver(row)
        .catch((err: unknown) =>
          this.deps.logger.error({ err, deliveryId: row.id }, "delivery failed unexpectedly"),
        )
        .finally(() => {
          this.inFlight.delete(send);
          this.wake();
        });
      this.inFlight.add(send);
    }
    return claimed.length;
  }

  /** Waits for in-flight sends (graceful shutdown). Anything unfinished is re-claimed after its lease. */
  async drain(timeoutMs = 10_000): Promise<void> {
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  /**
   * Due = PENDING/RETRYING past nextAttemptAt, or SENDING with an expired lease (crashed
   * mid-send). Never for a DISABLED endpoint.
   *
   * Free slots are handed out per endpoint (at most `perEndpoint` in flight) and per developer
   * (at most `perDeveloper`), so neither one slow endpoint nor one developer with many slow
   * endpoints can take every slot.
   *
   * A re-claimed crashed send keeps its attempt number: nothing was recorded for it, so it is
   * the same attempt again, not a new one.
   */
  private async claim(limit: number): Promise<Claimed[]> {
    return this.deps.prisma.$queryRaw<Claimed[]>`
      UPDATE "Delivery"
      SET status = 'SENDING',
          "leaseUntil" = now() + make_interval(secs => ${this.leaseSeconds}),
          "attemptCount" = "attemptCount" + CASE WHEN status = 'SENDING' THEN 0 ELSE 1 END,
          "updatedAt" = now()
      WHERE id IN (
        SELECT due.id
        FROM "Developer" dev
        CROSS JOIN LATERAL (
          SELECT per_endpoint.id, per_endpoint."nextAttemptAt"
          FROM "Endpoint" e
          CROSS JOIN LATERAL (
            SELECT d.id, d."nextAttemptAt"
            FROM "Delivery" d
            WHERE d."endpointId" = e.id
              AND (
                (d.status IN ('PENDING', 'RETRYING') AND d."nextAttemptAt" <= now())
                OR (d.status = 'SENDING' AND d."leaseUntil" < now())
              )
            ORDER BY d."nextAttemptAt"
            LIMIT GREATEST(0, ${this.perEndpoint} - (
              SELECT count(*) FROM "Delivery" s
              WHERE s."endpointId" = e.id AND s.status = 'SENDING' AND s."leaseUntil" > now()
            ))
            FOR UPDATE OF d SKIP LOCKED
          ) per_endpoint
          WHERE e."developerId" = dev.id AND e.status <> 'DISABLED'
          ORDER BY per_endpoint."nextAttemptAt"
          LIMIT GREATEST(0, ${this.perDeveloper} - (
            SELECT count(*) FROM "Delivery" s
            JOIN "Endpoint" se ON se.id = s."endpointId"
            WHERE se."developerId" = dev.id AND s.status = 'SENDING' AND s."leaseUntil" > now()
          ))
        ) due
        ORDER BY due."nextAttemptAt"
        LIMIT ${limit}
      )
      RETURNING id, "eventId", "endpointId", "attemptCount"`;
  }

  private async deliver(claimed: Claimed): Promise<void> {
    const startedAt = new Date();
    // Loaded at send time: a changed URL or rotated secret applies to the very next attempt.
    const delivery = await this.deps.prisma.delivery.findUnique({
      where: { id: claimed.id },
      include: { event: true, endpoint: true },
    });
    if (
      !delivery ||
      delivery.status !== "SENDING" ||
      delivery.attemptCount !== claimed.attemptCount
    )
      return;

    let result: HttpResult;
    try {
      const { endpoint, event } = delivery;
      const secrets = [
        endpoint.secretEnc,
        ...previousSecrets(endpoint, startedAt).map((s) => s.enc),
      ].map((enc) => decryptSecret(enc, this.deps.env.ENCRYPTION_KEY));
      // Computed once per attempt; these exact bytes are both signed and sent.
      const rawBody = JSON.stringify(event.payload);
      const headers = buildHeaders({
        eventId: event.id,
        attempt: claimed.attemptCount,
        timestamp: Math.floor(startedAt.getTime() / 1000),
        rawBody,
        secrets,
      });
      result = await this.deps.http.post(endpoint.url, headers, rawBody);
    } catch (err) {
      this.deps.logger.error(
        { err, deliveryId: claimed.id },
        "could not build or send the request",
      );
      result = {
        statusCode: null,
        error: null,
        snippet: null,
        durationMs: Date.now() - startedAt.getTime(),
      };
    }

    await this.record(claimed, delivery.event.developerId, startedAt, result);
  }

  /** Transaction B: the attempt row, the delivery's new state and the endpoint's counters commit together. */
  private async record(
    claimed: Claimed,
    developerId: string,
    startedAt: Date,
    result: HttpResult,
  ): Promise<void> {
    const { prisma } = this.deps;
    const outcome = classifyAttempt(result.statusCode, claimed.attemptCount);
    const now = new Date();
    const delay = outcome === "retry" ? nextDelayMs(claimed.attemptCount, this.deps.random) : null;
    const lastError = result.error ?? (result.statusCode === null ? "INTERNAL" : null);

    const change = await prisma.$transaction(async (tx): Promise<EndpointChange | null> => {
      await tx.deliveryAttempt.createMany({
        data: [
          {
            deliveryId: claimed.id,
            number: claimed.attemptCount,
            startedAt,
            durationMs: result.durationMs,
            statusCode: result.statusCode,
            error: lastError,
            responseSnippet: result.snippet,
          },
        ],
        skipDuplicates: true,
      });

      const status =
        outcome === "delivered"
          ? "DELIVERED"
          : outcome === "retry" && delay !== null
            ? "RETRYING"
            : "FAILED";
      const { count } = await tx.delivery.updateMany({
        // Only if it is still ours: it may have been cancelled or re-claimed in the meantime.
        where: { id: claimed.id, status: "SENDING", attemptCount: claimed.attemptCount },
        data: {
          status,
          leaseUntil: null,
          lastStatusCode: result.statusCode,
          lastError,
          ...(status === "DELIVERED" ? { deliveredAt: now } : {}),
          ...(status === "RETRYING" && delay !== null
            ? { nextAttemptAt: new Date(now.getTime() + delay) }
            : {}),
        },
      });
      if (count === 0) return null;

      const endpointChange = await applyEndpointEffect(
        tx,
        claimed.endpointId,
        outcome,
        claimed.attemptCount,
      );
      await notify(tx, CHANNELS.deliveriesUpdated, {
        developerId,
        deliveryId: claimed.id,
        eventId: claimed.eventId,
        status,
      });
      if (endpointChange) {
        await notify(tx, CHANNELS.endpointsUpdated, {
          developerId,
          endpointId: claimed.endpointId,
          status: endpointChange.status,
        });
      }
      return endpointChange;
    });

    if (change?.status === "DISABLED")
      await this.emailDisabled(claimed.endpointId, change.disabledReason);
  }

  private async emailDisabled(endpointId: string, reason: string | null): Promise<void> {
    const endpoint = await this.deps.prisma.endpoint.findUnique({
      where: { id: endpointId },
      include: { developer: { select: { email: true } } },
    });
    if (!endpoint) return;
    const why =
      reason === "GONE"
        ? "it responded with 410 Gone"
        : "20 events in a row could not be delivered after all retries";
    await this.deps.mailer.send({
      to: endpoint.developer.email,
      subject: "Your Webhook endpoint was disabled",
      text: `Your endpoint ${endpoint.url} was disabled because ${why}.\n\nNo further webhooks will be sent to it. Once it is fixed, re-enable it in the dashboard and use Replay to resend the failed events.`,
    });
  }
}
