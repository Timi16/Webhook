// Response shapes of the REST API. They document the API (OpenAPI) and are checked against real
// responses in the API's tests, so the reference cannot drift from what is actually returned.
import { z } from "zod";
import { healthResponseSchema } from "./health.js";
import { DELIVERY_STATUSES } from "./pagination.js";
import { memoRuleSchema } from "./watch.js";

const timestamp = z.string().describe("ISO 8601 date-time");
const nextCursor = z
  .string()
  .nullable()
  .describe("Pass as ?cursor= for the next page; null on the last page");

export const developerResponse = z.strictObject({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  workspace: z.string().nullable(),
  createdAt: timestamp,
});
export const developerEnvelope = z.strictObject({ developer: developerResponse });

export const apiKeyResponse = z.strictObject({
  id: z.string(),
  name: z.string(),
  prefix: z.string().describe("First characters of the key, e.g. whk_test_9f2a"),
  note: z.string().nullable(),
  scopes: z.array(z.string()).describe("payments:read, watches:write, endpoints:write"),
  allowedIps: z.array(z.string()).describe("IPv4 addresses or CIDR ranges; empty = any IP"),
  expiresAt: timestamp.nullable().describe("The key stops working at this time; null = never"),
  lastUsedAt: timestamp.nullable(),
  lastUsedIp: z.string().nullable(),
  revokedAt: timestamp.nullable(),
  createdAt: timestamp,
});
export const apiKeyEnvelope = z.strictObject({ apiKey: apiKeyResponse });
export const apiKeyDetailResponse = z.strictObject({
  apiKey: apiKeyResponse,
  usage: z.strictObject({
    requests: z.number().int().describe("Requests in the last 24 hours"),
    errors: z.number().int().describe("Of those, how many answered 4xx or 5xx"),
    medianMs: z.number().int().nullable(),
    hourly: z
      .array(
        z.strictObject({ hour: timestamp, requests: z.number().int(), errors: z.number().int() }),
      )
      .describe("One entry per hour, oldest first, 24 entries"),
  }),
  recentRequests: z
    .array(
      z.strictObject({
        id: z.string(),
        at: timestamp,
        method: z.string(),
        path: z.string().describe("Without the query string"),
        status: z.number().int(),
        durationMs: z.number().int(),
        ip: z.string().nullable(),
      }),
    )
    .describe("The 20 most recent requests; the log is kept for 7 days"),
});
export const apiKeyListResponse = z.strictObject({ data: z.array(apiKeyResponse) });
export const apiKeyCreatedResponse = z.strictObject({
  apiKey: apiKeyResponse,
  key: z.string().describe("The full key. Shown only once."),
});

export const endpointResponse = z.strictObject({
  id: z.string(),
  url: z.string(),
  description: z.string().nullable(),
  status: z.enum(["ACTIVE", "FAILING", "DISABLED"]),
  consecutiveFailures: z.number().int().describe("Failed events in a row, not attempts"),
  disabledReason: z.string().nullable(),
  eventTypes: z.array(z.string()).describe("Payment events this endpoint accepts"),
  previousSecretValidUntil: timestamp
    .nullable()
    .describe("Set while a rotated secret is still accepted"),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const endpointEnvelope = z.strictObject({ endpoint: endpointResponse });
export const endpointListResponse = z.strictObject({ data: z.array(endpointResponse) });
export const endpointCreatedResponse = z.strictObject({
  endpoint: endpointResponse,
  secret: z.string().describe("The signing secret (whsec_...). Shown only once."),
});
export const endpointDetailResponse = z.strictObject({
  endpoint: endpointResponse.extend({
    stats: z.strictObject({
      last24h: z.strictObject({
        delivered: z.number().int(),
        failed: z.number().int(),
        retrying: z.number().int(),
        pending: z.number().int(),
      }),
      lastAttempt: z
        .strictObject({
          at: timestamp,
          statusCode: z.number().int().nullable(),
          error: z.string().nullable(),
        })
        .nullable(),
    }),
  }),
});
export const rotatedSecretResponse = z.strictObject({
  secret: z.string().describe("The new signing secret. Shown only once."),
  previousSecretValidUntil: timestamp.nullable(),
});
export const testWebhookResponse = z.strictObject({
  eventId: z.string(),
  attempt: z
    .strictObject({
      statusCode: z.number().int().nullable(),
      durationMs: z.number().int(),
      error: z.string().nullable(),
    })
    .nullable()
    .describe("The first attempt, or null if it has not been sent within 12 s"),
});
export const replayResponse = z.strictObject({ requeued: z.number().int() });

const amount = z.string().describe('Decimal string with 7 places, e.g. "10.5000000"');
const stroops = z.string().describe("The same amount in stroops (1 unit = 10,000,000 stroops)");
const assetResponse = z.strictObject({
  code: z.string(),
  issuer: z.string().nullable().describe("null for XLM"),
});
const amountRuleResponse = z.union([
  z.strictObject({ kind: z.literal("any") }),
  z.strictObject({ kind: z.enum(["exact", "min", "max"]), amount, stroops }),
  z.strictObject({
    kind: z.literal("range"),
    min: amount,
    max: amount,
    minStroops: stroops,
    maxStroops: stroops,
  }),
]);

export const watchResponse = z.strictObject({
  id: z.string(),
  walletAddress: z.string(),
  label: z.string().nullable(),
  endpointId: z.string(),
  assets: z.array(assetResponse),
  amountRule: amountRuleResponse,
  memoRule: memoRuleSchema,
  senderAllowlist: z.array(z.string()),
  eventTypes: z.array(z.string()),
  startLedger: z.number().int().describe("Payments in earlier ledgers are ignored"),
  active: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const watchEnvelope = z.strictObject({ watch: watchResponse });
export const watchListResponse = z.strictObject({ data: z.array(watchResponse) });
export const watchWithWarningsResponse = z.strictObject({
  watch: watchResponse,
  warnings: z
    .array(z.string())
    .describe("ACCOUNT_NOT_FOUND, NO_TRUSTLINE:<code>, DUPLICATE_WATCH or HORIZON_UNAVAILABLE"),
});
export const watchDetailResponse = z.strictObject({
  watch: watchResponse,
  stats: z.strictObject({ verified24h: z.number().int(), rejected24h: z.number().int() }),
});

const outcome = z.enum(["VERIFIED", "REJECTED"]);
const paymentFields = {
  id: z.string(),
  txHash: z.string(),
  innerTxHash: z.string().nullable(),
  ledger: z.number().int(),
  ledgerClosedAt: timestamp,
  from: z.string(),
  to: z.string(),
  toMuxedId: z.string().nullable(),
  memo: z.string().nullable(),
  memoType: z.enum(["none", "text", "id", "hash"]),
  asset: assetResponse,
  amount,
  amountStroops: stroops,
  eventType: z.enum(["transfer", "mint"]),
  source: z.enum(["rpc", "horizon"]),
};
export const paymentListResponse = z.strictObject({
  data: z.array(
    z.strictObject({
      ...paymentFields,
      matches: z.array(
        z.strictObject({
          watchId: z.string(),
          outcome,
          reasons: z.array(z.string()),
          eventId: z.string().nullable(),
        }),
      ),
    }),
  ),
  nextCursor,
});

const check = z.strictObject({ passed: z.boolean(), reason: z.string().nullable() });
export const paymentDetailResponse = z.strictObject({
  payment: z.strictObject({
    ...paymentFields,
    matches: z.array(
      z.strictObject({
        watchId: z.string(),
        watchLabel: z.string().nullable(),
        outcome,
        reasons: z.array(z.string()),
        checks: z.strictObject({ asset: check, amount: check, memo: check, sender: check }),
        event: z
          .strictObject({
            id: z.string(),
            type: z.string(),
            createdAt: timestamp,
            deliveries: z.array(
              z.strictObject({
                id: z.string(),
                status: z.enum(DELIVERY_STATUSES),
                attemptCount: z.number().int(),
                deliveredAt: timestamp.nullable(),
              }),
            ),
          })
          .nullable(),
      }),
    ),
  }),
});

export const deliveryResponse = z.strictObject({
  id: z.string(),
  endpointId: z.string(),
  status: z.enum(DELIVERY_STATUSES),
  attemptCount: z.number().int(),
  nextAttemptAt: timestamp.nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  deliveredAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const deliveryEnvelope = z.strictObject({ delivery: deliveryResponse });

const eventFields = {
  id: z.string().describe("Also sent as the Webhook-Id header"),
  type: z.string(),
  createdAt: timestamp,
  watchId: z.string().nullable(),
  paymentId: z.string().nullable(),
};
const eventSummary = z
  .strictObject({
    amount,
    assetCode: z.string(),
    from: z.string(),
    watchLabel: z.string().nullable(),
    reasons: z.array(z.string()),
  })
  .nullable()
  .describe(
    "The payment an event is about, for showing a list without loading each payload. null for other event types.",
  );
export const eventListResponse = z.strictObject({
  data: z.array(
    z.strictObject({
      ...eventFields,
      summary: eventSummary,
      deliveries: z.array(deliveryResponse),
    }),
  ),
  nextCursor,
});
export const eventDetailResponse = z.strictObject({
  event: z.strictObject({
    ...eventFields,
    payload: z.record(z.string(), z.unknown()).describe("Exactly what is sent to the endpoint"),
    deliveries: z.array(
      deliveryResponse.extend({
        attempts: z.array(
          z.strictObject({
            number: z.number().int(),
            startedAt: timestamp,
            durationMs: z.number().int(),
            statusCode: z.number().int().nullable(),
            error: z.string().nullable(),
            responseSnippet: z
              .string()
              .nullable()
              .describe("First 1 KB of the response, plain text"),
          }),
        ),
      }),
    ),
  }),
});

export { healthResponseSchema as healthResponse };

export const overviewResponse = z.strictObject({
  windowHours: z.number().int(),
  payments: z.strictObject({
    total: z.number().int().describe("Payments evaluated by your watches in the window"),
    verified: z.number().int(),
    rejected: z.number().int(),
    previousTotal: z.number().int().describe("The same count for the window before this one"),
  }),
  deliveries: z.strictObject({
    delivered: z.number().int(),
    retrying: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    medianMs: z.number().int().nullable().describe("Median duration of successful attempts"),
    p95Ms: z.number().int().nullable(),
  }),
  watches: z.strictObject({ active: z.number().int(), paused: z.number().int() }),
  hourly: z
    .array(
      z.strictObject({ hour: timestamp, verified: z.number().int(), rejected: z.number().int() }),
    )
    .describe("One entry per hour, oldest first; the last one is the current hour"),
});

export const accountResponse = z.strictObject({
  address: z.string(),
  exists: z.boolean().nullable().describe("null when Horizon could not be reached"),
  assets: z
    .array(assetResponse)
    .describe("Assets the account can receive: XLM plus one per trustline"),
});

export const COMPONENT_STATES = ["operational", "degraded", "outage"] as const;
export const DAY_STATES = [
  "operational",
  "degraded",
  "partial_outage",
  "major_outage",
  "no_data",
] as const;
export const statusResponse = z.strictObject({
  status: z.enum(COMPONENT_STATES).describe("The worst current state of any component"),
  updatedAt: timestamp,
  components: z.array(
    z.strictObject({
      key: z.string(),
      name: z.string(),
      description: z.string(),
      status: z.enum(COMPONENT_STATES).describe("Right now"),
      uptimePercent: z
        .number()
        .nullable()
        .describe("Share of checks that passed over the days with data; null with no data"),
      days: z
        .array(
          z.strictObject({
            date: z.string().describe("UTC day, YYYY-MM-DD"),
            status: z.enum(DAY_STATES),
            uptimePercent: z.number().nullable(),
          }),
        )
        .describe("90 entries, oldest first, ending today"),
    }),
  ),
});

export const auditLogResponse = z.strictObject({
  data: z.array(
    z.strictObject({
      id: z.string(),
      at: timestamp,
      action: z.string().describe("For example api_key.created or endpoint.secret_rotated"),
      targetId: z.string().nullable(),
      targetLabel: z.string().nullable().describe("The name, URL or label of what was changed"),
      detail: z.string().nullable().describe("What the change did, in a few words"),
      actor: z.enum(["session", "api_key"]).describe("The dashboard, or an API key"),
      apiKeyId: z.string().nullable(),
      ip: z.string().nullable(),
    }),
  ),
  nextCursor,
});
