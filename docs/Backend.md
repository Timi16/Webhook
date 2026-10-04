Backend
Stack and repo structure
One TypeScript codebase in apps/api builds one Docker image that starts as either the api process (node dist/server.js) or the worker process (node dist/worker.js).
Stack
Concern
Choice
Runtime
Node.js 22 LTS
HTTP
Express 5
Language
TypeScript 5, strict: true, noUncheckedIndexedAccess: true
Database
PostgreSQL 16 via Prisma 6 (plus pg for LISTEN/NOTIFY)
Validation + OpenAPI
Zod + @asteasolutions/zod-to-openapi
Stellar
@stellar/stellar-sdk (rpc.Server, Horizon.Server, StrKey, scValToNative)
Outbound HTTP
undici with a custom SSRF-checking connect
Security
helmet, cors, express-rate-limit, cookie-parser, argon2
IDs
ulid for event IDs, cuid for everything else
Logging
pino + pino-http
Tests
Vitest, supertest, @testcontainers/postgresql
Pin the latest stable versions at setup time and commit the lockfile.
Folder structure
apps/api/
  prisma/
    schema.prisma
    migrations/
  src/
    server.ts              # api process: build app, listen, graceful shutdown
    worker.ts              # worker process: start ingestion, reconciliation, watchdog, dispatcher
    app.ts                 # buildApp(): Express app, exported for tests
    config/env.ts          # Zod-validated env; refuses to boot on bad config or non-testnet passphrase
    db/
      prisma.ts            # single PrismaClient
      notify.ts            # pg LISTEN/NOTIFY helper
    lib/
      amount.ts            # string <-> bigint stroops
      crypto.ts            # AES-256-GCM encrypt/decrypt for endpoint secrets
      hmac.ts              # webhook signature
      ids.ts               # evt_ ULIDs, API key generation
      errors.ts            # AppError + error codes
      logger.ts            # pino with redaction
    middleware/
      requestId.ts
      auth.ts              # requireSession | requireApiKey | requireAny
      requireOrigin.ts     # CSRF check for cookie auth
      rateLimit.ts
      validate.ts          # validate({ body, query, params }) with Zod
      errorHandler.ts
    modules/               # each: routes.ts, service.ts, repo.ts, schemas.ts
      auth/
      apiKeys/
      watches/
      endpoints/
      payments/
      events/
      stream/              # SSE
      health/
    engine/
      sources/
        StellarSource.ts   # interface
        rpcEventSource.ts
        horizonBackfill.ts
      decode.ts            # RPC event -> NormalizedPayment
      watchedSet.ts        # in-memory set of watched wallets
      evaluate.ts          # pure evaluateWatch()
      matcher.ts           # transaction A
      ingestion.ts         # main loop + cursor
      reconciliation.ts
      watchdog.ts
      networkReset.ts
    delivery/
      payload.ts           # build frozen payload
      signer.ts            # headers + signature
      safeHttp.ts          # SSRF-safe undici client
      schedule.ts          # retry delays with jitter
      dispatcher.ts        # claim, send, record
      endpointHealth.ts    # FAILING / DISABLED transitions
    openapi/
      registry.ts
      generate.ts          # writes openapi.json for the docs site
  test/
    unit/  integration/  delivery/  helpers/
packages/shared/src/
  schemas/                 # Zod schemas shared with the dashboard
  types.ts
scripts/
  scenario.ts              # testnet scenarios + demo
  mock-receiver.ts         # scriptable webhook receiver
  chaos.sh
Layering rule
routes (HTTP only: validate, call service, shape response) → service (business rules) → repo (Prisma only). Every repo function that touches tenant data takes developerId as its first argument and includes it in the where. Routes never import Prisma directly.
Express app
buildApp() wires middleware in a fixed order; tests import the same function, so what's tested is exactly what runs.
Middleware order
1. app.set("trust proxy", TRUST_PROXY: 1 in production, 0 otherwise), app.disable("x-powered-by")
2. requestId: reads X-Request-Id or generates one; echoes it on the response
3. pino-http with redaction
4. helmet
5. cors({ origin: DASHBOARD_ORIGIN, credentials: true })
6. express.json({ limit: "100kb" }), cookieParser()
7. Global rate limit (60/min per IP for unauthenticated routes)
8. Routes:
    ◦ GET /health: no auth
    ◦ /auth/*: auth rate limit (5/min per IP) + requireOrigin
    ◦ /v1/*: requireAny (session or API key), requireOrigin when the session path was used, 300/min per developer
    ◦ GET /v1/stream: session only, SSE
9. 404 handler → NOT_FOUND
10. errorHandler
Express 5 forwards rejected promises from async handlers to the error handler, so no asyncHandler wrapper is needed.
Authentication
• requireAny: if Authorization: Bearer whk_test_… is present, hash it, look up a non-revoked ApiKey, and set req.auth = { developerId, via: "apiKey", apiKeyId }. Otherwise read the whk_session cookie, hash it, look up an unexpired Session, and set req.auth = { developerId, via: "session" }. Neither → 401.
• Sessions last 14 days and are deleted on logout. Changing the password deletes all of that developer's sessions.
• requireOrigin: for cookie-authenticated POST, PATCH, DELETE, the Origin header must equal DASHBOARD_ORIGIN or the request gets 403 FORBIDDEN_ORIGIN.
Validation
validate({ body, query, params }) parses with Zod (.strict()) and puts results on req.valid. Handlers read only req.valid, never req.body. The same schemas live in packages/shared so the dashboard validates forms identically.
Error format
Every error response has one shape:
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "walletAddress is not a valid Stellar public key",
    "details": [{ "path": "walletAddress", "issue": "invalid_stellar_address" }],
    "requestId": "01J9Z…"
  }
}
Code
HTTP
When
VALIDATION_FAILED
400
Zod failure
SECRET_KEY_REJECTED
400
An S… secret key was submitted as an address
INSECURE_URL
400
Endpoint URL isn't HTTPS, has credentials, or uses a disallowed port
SSRF_BLOCKED
400
Endpoint resolves to a private or internal IP
UNAUTHENTICATED
401
No or invalid session / API key
FORBIDDEN_ORIGIN
403
CSRF check failed
NOT_FOUND
404
Missing, deleted, or belongs to another developer (never 403, so IDs can't be probed)
CONFLICT
409
Email already registered, endpoint in use by active watches on delete
RATE_LIMITED
429
Includes Retry-After
INTERNAL
500
Unexpected; message is generic, stack only in logs
Pagination
List endpoints take ?limit (1–100, default 50) and ?cursor, and return { "data": [...], "nextCursor": "…" | null }. The cursor is an opaque base64 of (createdAt, id), so results stay stable while new rows arrive.
Graceful shutdown
On SIGTERM: stop accepting connections, end SSE streams, wait up to 10 s for in-flight requests, then prisma.$disconnect(). The worker stops claiming new deliveries, waits up to 10 s for in-flight sends, and exits; any unfinished send is re-claimed after its lease expires.
Stellar engine (Deliverable 1)
The engine turns raw Stellar events into ChainPayment rows and match results, exactly once per event. Only matcher.ts writes to the database; decode.ts and evaluate.ts are pure functions with exhaustive unit tests.
Core types
export interface NormalizedPayment {
  eventId: string;            // RPC event id (unique)
  txHash: string;
  innerTxHash?: string;       // fee-bump inner hash, when present
  ledger: number;
  ledgerClosedAt: Date;
  from: string;               // base G (or C for contract wallets)
  to: string;                 // base G, muxed part stripped
  toMuxedId?: string;
  memo: string | null;
  memoType: "none" | "text" | "id" | "hash";
  asset: { code: string; issuer: string | null }; // issuer null = XLM
  amountStroops: bigint;
  eventType: "transfer" | "mint";
  source: "rpc" | "horizon";
}

export interface EventCursor { ledger: number; pagingToken?: string }

export interface StellarSource {
  latestLedger(): Promise<number>;
  oldestLedger(): Promise<number>;           // start of RPC's retention window
  fetch(from: EventCursor, limit: number): Promise<{
    payments: NormalizedPayment[];
    next: EventCursor;
  }>;
}

export type ReasonCode =
  | "WRONG_ASSET" | "WRONG_ISSUER"
  | "AMOUNT_NOT_EXACT" | "AMOUNT_BELOW_MIN" | "AMOUNT_ABOVE_MAX"
  | "MEMO_MISSING" | "MEMO_MISMATCH" | "MEMO_TYPE_MISMATCH" | "MEMO_NOT_ALLOWED"
  | "SENDER_NOT_ALLOWED";

export function evaluateWatch(p: NormalizedPayment, w: ParsedWatch):
  { outcome: "VERIFIED" | "REJECTED"; reasons: ReasonCode[] };
rpcEventSource.ts
• Uses rpc.Server(STELLAR_RPC_URL).getEvents(): first call with startLedger, later calls with the returned paging cursor; limit 200.
• Filter: type: "contract", topic 0 = transfer or mint, destination topic = a watched wallet (one filter per wallet). Never filtered by asset contract ID: a wrong-asset or fake-issuer payment must still arrive so it can be recorded as REJECTED (W3).
• RPC allows 5 filters per call. With more than 5 watched wallets, keep only the transfer/mint topic filter and filter by wallet in memory.
• Decode with scValToNative: topics give from, to and the asset string (USDC:G… or native); data gives the amount (i128) and, when present, to_muxed_id. mint has 3 topics (to, asset); the issuer is the sender.
• The decoder only trusts an event whose contractId is the Stellar Asset Contract of the asset it names. Any contract can emit a transfer event that claims to be USDC.
• to_muxed_id carries either the destination's mux ID or the transaction memo. Map its type: string → text, u64 → id, bytes → hash (hex, exactly 32 bytes). A u64 is ambiguous, so for payments about to be recorded the source looks the transaction up (getTransaction, cached per hash): if the operation paid an M-address, toMuxedId is set and the payment gets the transaction's real memo back; the mux ID only stands in as an ID memo when the transaction has none. Horizon-backfilled payments follow the same rule.
• Spike result (3 Oct 2026, testnet): every classic payment, path payment, account creation, issuer mint and contract transfer produced one event with amount, asset and memo. Soroban transactions cannot carry a memo, so no getTransaction fallback is needed.
ingestion.ts (main loop)
loop forever:
  cursor = Cursor.load("rpc-events")
  tip    = source.latestLedger()
  if tip < cursor.ledger - 100          -> networkReset.handle(tip); continue
  if cursor.ledger < source.oldestLedger() -> horizonBackfill(watchedWallets, cursor); continue
  { payments, next } = source.fetch(cursor, 200)
  relevant = payments.filter(p => watchedSet.has(p.to))
  prisma.$transaction(tx => {
    for p of relevant: matcher.process(tx, p)
    Cursor.save(tx, next)                 // saved even when nothing was relevant
  }, { timeout: 15_000 })
  NOTIFY deliveries, payments
  heartbeat = now
  sleep(payments.length === 200 ? 0 : 2_000)
on error: log, backoff 1s -> 2s -> 4s ... max 30s, never save the cursor
On first boot (no cursor), start at latestLedger(), not genesis.
matcher.ts (inside transaction A)
1. INSERT INTO ChainPayment … ON CONFLICT DO NOTHING RETURNING eventId. No row returned → already processed → return.
2. watches = watchedSet.get(p.to).filter(w => w.active && !w.deletedAt && w.startLedger <= p.ledger).
3. For each watch: evaluateWatch → insert PaymentMatch (ON CONFLICT DO NOTHING).
4. If VERIFIED, or REJECTED and "payment.rejected" is in watch.eventTypes: build the frozen payload, insert WebhookEvent (id evt_<ulid>, matchId unique) and one Delivery for watch.endpointId with nextAttemptAt = now().
evaluate.ts rules
Collect every failing reason (don't stop at the first), so the dashboard shows the full picture.
Check
Rule
Reason on failure
Asset
Payment's code + issuer must equal one of watch.assets; same code with a different issuer is a counterfeit
WRONG_ASSET / WRONG_ISSUER
Amount
exact: equal · min/max: inclusive · range: inclusive both ends · any: always passes
AMOUNT_NOT_EXACT / AMOUNT_BELOW_MIN / AMOUNT_ABOVE_MAX
Memo
equals: same type and same value (trimmed; ID compared as decimal strings) · present: not none · absent: must be none
MEMO_MISMATCH / MEMO_TYPE_MISMATCH / MEMO_MISSING / MEMO_NOT_ALLOWED
Sender
If the allowlist isn't empty, from must be in it (compare base addresses)
SENDER_NOT_ALLOWED
Supporting loops
• watchedSet.ts: Map<wallet, ParsedWatch[]> loaded at boot; reloaded on NOTIFY watches_changed (500 ms debounce) and every 30 s as a safety net. Watch create/update/delete in the API sends that notify.
• reconciliation.ts: every 2 min, re-fetch from max(cursor.ledger - 60, oldestLedger) up to the cursor and run every payment through matcher.process. Duplicates hit the primary key and are skipped. It never moves the main cursor.
• watchdog.ts: every 15 s: lag = tip - cursor.ledger. Over 12 ledgers for 2 min → Telegram alert. Main loop heartbeat older than 60 s → process.exit(1) so Docker restarts the worker.
• networkReset.ts: set the cursor to the new tip, store lastNetworkResetAt, create a system.network_reset event for every active endpoint, alert.
• horizonBackfill.ts: for each watched wallet, page /accounts/{id}/payments?join=transactions&order=asc from the gap start (plus /operations for claimable-balance claims); map records to NormalizedPayment with source: "horizon" and an eventId derived from the operation ID, so live and backfilled rows never collide.
Dispatcher (Deliverable 2)
The dispatcher runs in the worker process, claims due deliveries from Postgres, sends each one through the SSRF-safe client, and records the result. It holds at most 50 sends in flight overall (MAX_CONCURRENT_DELIVERIES), 10 per developer and 5 per endpoint.
Claiming
Wakes on LISTEN deliveries, and polls every 1 s as a fallback.
UPDATE "Delivery"
SET status = 'SENDING',
    "leaseUntil" = now() + interval '60 seconds',
    "attemptCount" = "attemptCount" + CASE WHEN status = 'SENDING' THEN 0 ELSE 1 END,
    "updatedAt" = now()
WHERE id IN (
  SELECT due.id
  FROM "Developer" dev
  CROSS JOIN LATERAL (
    SELECT count(*) AS in_flight
    FROM "Delivery" s JOIN "Endpoint" se ON se.id = s."endpointId"
    WHERE se."developerId" = dev.id AND s.status = 'SENDING' AND s."leaseUntil" > now()
  ) busy
  CROSS JOIN LATERAL (
    SELECT per_endpoint.id, per_endpoint."nextAttemptAt",
           row_number() OVER (ORDER BY per_endpoint."nextAttemptAt") AS turn
    FROM "Endpoint" e
    CROSS JOIN LATERAL (
      SELECT d.id, d."nextAttemptAt"
      FROM "Delivery" d
      WHERE d."endpointId" = e.id
        AND (
          (d.status IN ('PENDING', 'RETRYING') AND d."nextAttemptAt" <= now())
          OR (d.status = 'SENDING' AND d."leaseUntil" < now())   -- crashed mid-send
        )
      ORDER BY d."nextAttemptAt"
      LIMIT GREATEST(0, 5 - (                                    -- this endpoint's free slots
        SELECT count(*) FROM "Delivery" s
        WHERE s."endpointId" = e.id
          AND s.status = 'SENDING' AND s."leaseUntil" > now()
      ))
      FOR UPDATE OF d SKIP LOCKED
    ) per_endpoint
    WHERE e."developerId" = dev.id AND e.status <> 'DISABLED'
    ORDER BY per_endpoint."nextAttemptAt"
    LIMIT GREATEST(0, 10 - busy.in_flight)                       -- this developer's free slots
  ) due
  ORDER BY busy.in_flight + due.turn, due."nextAttemptAt"        -- fewest in flight first
  LIMIT $1                                                       -- free slots, max 50
)
RETURNING id, "eventId", "endpointId", "attemptCount";
Limits are applied as LATERAL … LIMIT per endpoint (5) and per developer (10), not as a filter on already-sending rows: a single claim would otherwise take every free slot for one idle endpoint, and one developer with several slow endpoints could hold every slot. Free slots go to the developer with the fewest sends in flight first, so a newly due delivery never queues behind other developers' backlogs; at worst it waits for one slot to free up (10 s, the send timeout).
A row re-claimed after an expired lease keeps its attempt number: nothing was recorded for the crashed send, so it is the same attempt again. Webhook-Attempt and the 10-attempt limit therefore count real, recorded attempts.
Request format
Header
Value
Content-Type
application/json
User-Agent
Webhook/1.0 (+https://docs.webhook.<domain>)
Webhook-Id
Event ID, e.g. evt_01J9Z6K3QW… (same on every retry and resend)
Webhook-Timestamp
Unix seconds at send time
Webhook-Attempt
Attempt number, starting at 1
Webhook-Signature
v1=<hex>; during a rotation grace window, v1=<new>, v1=<old>
• Secret format: whsec_ + 32 random bytes, base64url. The HMAC key is the UTF-8 bytes of the full secret string.
• Signature: hex(HMAC_SHA256(secret, timestamp + "." + rawBody)).
• Raw body: JSON.stringify(event.payload) is computed once per attempt and those exact bytes are both signed and sent.
safeHttp.ts
• undici Agent with a custom connect.lookup: dns.lookup(host, { all: true }), reject if any resolved address is in a blocked range (checked with ipaddr.js), otherwise connect to the first allowed address.
• Blocked: loopback, private (10/8, 172.16/12, 192.168/16), link-local (169.254/16, incl. the 169.254.169.254 metadata address), CGNAT (100.64/10), 0.0.0.0/8, multicast, broadcast, IPv6 ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 (::ffff:0:0/96).
• Redirects never followed; total timeout 10 s via AbortSignal.timeout(10_000); read at most 64 KB of the response, then destroy the stream; store the first 1 KB.
• Errors are mapped to TIMEOUT, DNS, CONN_REFUSED, TLS, SSRF_BLOCKED, REDIRECT (any 3xx), BODY_TOO_LARGE.
Recording the result (transaction B)
Result
Delivery becomes
Endpoint effect
2xx
DELIVERED, deliveredAt set
consecutiveFailures = 0, status ACTIVE
410 Gone
FAILED
DISABLED (reason GONE), developer emailed
Anything else, attempts < 10
RETRYING, nextAttemptAt = now + next delay
status FAILING
Anything else, attempt 10
FAILED
consecutiveFailures + 1; at 20 → DISABLED (reason TOO_MANY_FAILURES), developer emailed
Every attempt inserts a DeliveryAttempt row (number, start time, duration, status code, error, snippet) in the same transaction, then NOTIFY deliveries_updated.
Retry schedule (schedule.ts)
Delays after failed attempts 1 to 9: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h, each with ±20% random jitter. Attempt 10 failing → FAILED. Total span ≈ 2 days.
Controls
• Resend (POST /v1/events/:id/resend): sets the event's deliveries to PENDING, due now. If one is currently SENDING with a live lease → 409 CONFLICT ("already sending"). Attempt numbering continues.
• Test webhook (POST /v1/endpoints/:id/test): creates a test.ping event + delivery, waits up to 12 s for the first attempt, and returns its result inline.
• Replay (POST /v1/endpoints/:id/replay with since): resets up to 1,000 FAILED deliveries since that time to PENDING.
• Rotate secret: new secret becomes current; old one moves to prevSecretEnc with prevSecretUntil = now + 24 h; both signatures sent until then. Rotating again inside the window keeps the earlier secrets valid until their own deadlines (up to 3 previous secrets, stored as a JSON list in prevSecretEnc).
• Re-enable endpoint: DISABLED → ACTIVE, consecutiveFailures = 0; nothing is replayed automatically.
• Delete endpoint: 409 if active watches use it; otherwise its unfinished deliveries become CANCELLED.
• Emails use Resend's API if RESEND_API_KEY is set; otherwise they are logged only.
REST API contract
All routes return JSON; errors use the shared error shape; IDs belonging to another developer always return 404. "Session" means the dashboard cookie; "Any" means session or API key.
Auth (session)
Method + path
Body
Success
POST /auth/signup
email, password, name?
201 { developer } + cookie
POST /auth/login
email, password
200 { developer } + cookie
POST /auth/logout
—
204, cookie cleared
GET /auth/me
—
200 { developer }
POST /auth/password
currentPassword, newPassword
204, all other sessions deleted
PATCH /auth/me
name?, workspace? (null clears it)
200 { developer }
POST /auth/email
email, password
204, emails a 1-hour confirmation link to the new address; nothing changes until it is opened
POST /auth/email/confirm
token
200 { developer }, the new address is now the login
DELETE /auth/me
password
204, deletes the account with its watches, endpoints, API keys and history; cookie cleared
POST /auth/forgot
email
204 always (no account enumeration); emails a 1-hour reset link if RESEND_API_KEY is set
POST /auth/reset
token, newPassword
204
API keys (session only; GET /v1/audit-log, also session only, lists every account change)
Method + path
Body
Success
GET /v1/api-keys
—
{ data: ApiKey[] } (prefix, name, dates; never the key)
POST /v1/api-keys
name, note?, scopes?, allowedIps?, expiresAt?
201 { apiKey, key: "whk_test_…" }, full key shown only here
GET /v1/api-keys/:id
—
{ apiKey, usage (last 24 h, hourly), recentRequests (20) }
PATCH /v1/api-keys/:id
name?, note?, scopes?, allowedIps?, expiresAt?
200 { apiKey }, applies to the key's next request
POST /v1/api-keys/:id/roll
—
201 { apiKey, key }, a new key; the old one keeps working for 24 hours
DELETE /v1/api-keys/:id
— (?permanent=true to remove it)
204 (revoked, kept for history; with permanent=true the row is deleted)
Endpoints (any)
Method + path
Body
Success
GET /v1/endpoints
—
{ data: Endpoint[] }
POST /v1/endpoints
url, description?
201 { endpoint, secret: "whsec_…" }, secret shown only here
GET /v1/endpoints/:id
—
{ endpoint } with recent failure stats
PATCH /v1/endpoints/:id
url?, description?
{ endpoint } (new URL re-checked for SSRF)
DELETE /v1/endpoints/:id
—
204; 409 if active watches use it
POST /v1/endpoints/:id/rotate-secret
—
{ secret } (old one valid 24 h)
POST /v1/endpoints/:id/test
—
{ eventId, attempt: { statusCode, durationMs, error } }
POST /v1/endpoints/:id/enable
—
{ endpoint }
POST /v1/endpoints/:id/replay
since (ISO date)
{ requeued: number } (max 1,000)
Watches (any)
Method + path
Body / query
Success
GET /v1/watches
?wallet, ?active
{ data: Watch[] }
POST /v1/watches
See example below
201 { watch, warnings[] }
GET /v1/watches/:id
—
{ watch, stats: { verified24h, rejected24h } }
PATCH /v1/watches/:id
Any create field except walletAddress
{ watch, warnings[] } (applies from the next ledger)
POST /v1/watches/:id/pause / resume
—
{ watch }
DELETE /v1/watches/:id
—
204 (soft delete; history kept)
Creating a watch checks the wallet on Horizon (GET /accounts/{id}). A missing account or missing trustline returns a warning (ACCOUNT_NOT_FOUND, NO_TRUSTLINE:USDC), not an error, so developers can set things up in any order.
// POST /v1/watches
{
  "walletAddress": "GABC…",
  "label": "Shop checkout",
  "endpointId": "clx…",
  "assets": [{ "code": "USDC", "issuer": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }],
  "amountRule": { "kind": "min", "amount": "10" },
  "memoRule": { "kind": "present" },
  "senderAllowlist": [],
  "eventTypes": ["payment.received"],
  "backfillHours": 0
}
Amounts in requests are decimal strings ("10", "10.5"); the API converts them to stroops and returns both forms.
Payments and events (any)
Method + path
Query
Success
GET /v1/payments
watchId, wallet, outcome, from, to, cursor, limit
{ data: Payment[], nextCursor }, each with its match results for this developer's watches
GET /v1/payments/:eventId
—
Payment, rule-by-rule results, linked webhook events
GET /v1/events
type, deliveryStatus, watchId, cursor, limit
{ data: WebhookEvent[], nextCursor }
GET /v1/events/:id
—
Event, payload, deliveries with all attempts
POST /v1/events/:id/resend
—
202 { delivery }; 409 if currently sending
Live stream (session)
GET /v1/stream is Server-Sent Events, scoped to the logged-in developer. Event names: payment.detected, delivery.updated, endpoint.updated, system.notice. A : ping comment every 25 s keeps proxies from closing it. The API process LISTENs once and fans out to connected clients by developerId.
Health (public)
GET /health → { status: "ok" | "degraded", db: true, lastLedger, lagSeconds, dueDeliveries }; 503 when the DB is unreachable.
Config, env vars and scripts
config/env.ts parses process.env with Zod at startup; a missing or malformed value stops the process with a clear message before anything connects.
Environment variables
Variable
Example
Used by
Rule
NODE_ENV
production
both
development / test / production
PORT
4000
api

DATABASE_URL
postgresql://webhook:…@postgres:5432/webhooks
both

STELLAR_RPC_URL
https://soroban-testnet.stellar.org
worker

HORIZON_URL
https://horizon-testnet.stellar.org
both
Backfill + trustline checks
NETWORK_PASSPHRASE
Test SDF Network ; September 2015
both
Must equal the testnet passphrase or boot fails
USDC_ISSUER
GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
both
Valid G address
DASHBOARD_ORIGIN
https://webhook.<domain>
api
CORS + CSRF check
SESSION_SECRET
64 random hex chars
api
≥ 32 bytes
ENCRYPTION_KEY
32 bytes, base64
both
Exactly 32 bytes after decoding
RESEND_API_KEY
re_…
both
Optional; emails are logged if absent
ALERT_TELEGRAM_BOT_TOKEN / ALERT_TELEGRAM_CHAT_ID

worker
Optional; alerts are logged if absent
EMAIL_FROM
Webhook <onboarding@resend.dev>
both
Optional; sender for endpoint-disabled and password-reset emails
ALLOW_INSECURE_WEBHOOK_TARGETS
false
both
Local development only: allows http, any port and private IPs as webhook targets (the mock receiver). Boot fails if true in production
MAX_CONCURRENT_DELIVERIES
50
worker
Webhooks sent at the same time, overall (1–200). Per developer (10) and per endpoint (5) are fixed
LOG_LEVEL
info
both

Keep .env.example in sync with this table; CI fails if a variable read in env.ts is missing from it.
npm scripts (apps/api/package.json)
Script
Does
dev
tsx watch src/server.ts
dev:worker
tsx watch src/worker.ts
build
tsc -p tsconfig.build.json
start / start:worker
node dist/server.js / node dist/worker.js
lint, typecheck, test
ESLint, tsc --noEmit, Vitest
test:delivery
Delivery tests against the mock receiver
db:migrate / db:deploy
prisma migrate dev / prisma migrate deploy
openapi
Writes openapi.json for the docs site
Repo scripts (/scripts)
Script
Does
scenario.ts
Creates Friendbot accounts and trustlines, then runs every testnet scenario (normal, wrong asset, fake-issuer USDC, wrong amount, memo cases, path payment, M-address) and asserts results through the API. Also the live demo.
mock-receiver.ts
Local receiver (plain http by default, so run the API and worker with ALLOW_INSECURE_WEBHOOK_TARGETS=true); per-request mode set by query or admin route: ok, 500, timeout, redirect, gone, slow, large, flaky:N
chaos.sh
Kills the worker mid-burst, points RPC at a dead host, stops Postgres for 60 s, then checks counts
seed.ts
Creates a demo developer, endpoint and watches for local development
Testing plan
Every edge case below has an ID; each gets at least one test whose name starts with that ID (it("W7: paused watch ignores new payments", …)), so coverage can be checked with a single grep.
Test layers
Layer
Tools
Covers
Unit
Vitest
amount, decode, evaluate, schedule, hmac, crypto, SSRF range checks
Property
fast-check
Amount string ↔ stroops round-trips; evaluator never throws on any valid input
Integration
Vitest + @testcontainers/postgresql + supertest
API routes, matcher transactions, idempotency, tenant isolation, crash replay with a fake StellarSource
Delivery
Vitest + mock-receiver + fake timers
Retries, leases, statuses, headers, signatures
Testnet
scripts/scenario.ts
Real payments end to end on the deployed service
Chaos
scripts/chaos.sh
Recovery with zero lost or duplicated payments and events
Monitoring cases (Deliverable 1)
ID
Case
Expected
W1
Payment passes every rule
VERIFIED match + payment.received event
W2
Fails amount, memo or sender rule
REJECTED with every failing reason; payment.rejected only if opted in
W3
"USDC" from a different issuer
REJECTED, WRONG_ISSUER
W4
Two watches on one wallet both match
Two matches, two events
W5
Same event from live loop and reconciliation
One ChainPayment, one match, one event
W6
Payment ledger before the watch's startLedger
Ignored
W7
Watch paused or deleted
New payments ignored; existing deliveries continue
W8
Rules edited after an event exists
Old payload unchanged; new rules apply from next ledger
W9
Wallet missing account or trustline
Watch saved with a warning
W10
Path payment, contract-wallet payer, M-address destination, issuer mint
Each detected and matched to the base wallet
W11
Memo as MEMO_ID or MEMO_HASH
Correct memoType; ID as decimal string, hash as hex
W12
Amount exactly on min, max or range edges
Passes (inclusive)
W13
Allowlisted sender pays from an M-address
Compared on base address; passes
W14
Busy wallet over 600 events/min
Events queue, dashboard warning, nothing dropped
W15
Testnet reset (tip ledger drops)
Cursor reset, system.network_reset to every active endpoint, alert
Delivery cases (Deliverable 2)
ID
Case
Expected
D1
2xx
DELIVERED, endpoint ACTIVE
D2
4xx/5xx other than 410
RETRYING with the next delay
D3
No response in 10 s
Attempt error TIMEOUT, retried
D4
Receiver processed it but returned 500
Retried with the same Webhook-Id
D5
3xx redirect
Not followed, error REDIRECT, retried
D6
410 Gone
FAILED, endpoint DISABLED, email sent
D7
DNS failure, refused, bad TLS
Matching error code, retried
D8
URL resolves to a blocked IP (incl. DNS rebinding after save)
SSRF_BLOCKED on save; at send time attempt fails with SSRF_BLOCKED
D9
Response body over 64 KB
Read stops at 64 KB, 1 KB stored, status still honoured
D10
One slow endpoint with 50 due deliveries
Never more than 5 in flight to it; others unaffected
D11
Worker killed mid-send
Re-claimed after the 60 s lease, same Webhook-Id
D12
Resend while SENDING
409; resend after it finishes → one new attempt
D13
Secret rotated during retries
Both signatures for 24 h; then only the new one
D14
Endpoint re-enabled
Status ACTIVE, nothing replayed until Replay is used
D15
Endpoint URL changed during retries
Next attempt goes to the new URL
D16
10th attempt fails
FAILED; 20th consecutive failed event disables the endpoint
API and account cases (Deliverable 3)
ID
Case
Expected
A1
Invalid address, or an S… secret key pasted
400 VALIDATION_FAILED / SECRET_KEY_REJECTED; secret never logged
A2
Non-HTTPS URL, credentials in URL, bad port
400 INSECURE_URL
A3
Revoked API key used
401
A4
Identical watch created twice
Created, with a DUPLICATE_WATCH warning
—
Developer A requests any of developer B's resources
404 on every route (one test per route)
Signature test vector
A fixed secret, timestamp and body with a known expected signature live in test/fixtures/signature.json. The same vector is used in the docs site's verification snippet test, so the docs can never drift from the signer.
Chaos checks (before handover)
• Kill webhook-worker during a burst of 50 payments → restart → exactly 50 ChainPayment rows and 50 events.
• Point STELLAR_RPC_URL at a dead host for 5 min → lag alert fires → full catch-up after restore.
• Stop Postgres for 60 s → API returns 503, worker backs off, nothing lost.
• Mock receiver returns 500 for 10 min, then 200 → every event delivered; receiver sees duplicates only with the same Webhook-Id.
Implementation notes
Decisions made while building, where the spec was silent or needed a correction.
• Webhook payload: { id, type, apiVersion, createdAt, data }. For payment events data holds payment (id, txHash, ledger, ledgerClosedAt, from, to, toMuxedId, memo, memoType, asset, amount, amountStroops), watch (id, label, walletAddress) and verification (outcome, reasons). Field names are camelCase, like the REST API.
• Resuming a paused watch sets startLedger to the next ledger, so payments that arrived while it was paused stay ignored (otherwise reconciliation would match them after the resume).
• Password reset tokens are stateless: an HMAC (SESSION_SECRET) over the developer ID, expiry and current password hash. They die as soon as the password changes.
• API key limits (added 4 Oct 2026). A key has scopes (payments:read, watches:write, endpoints:write; all three by default), an optional list of allowed IPv4 addresses or CIDR ranges, and an optional expiresAt. payments:read covers payments, events and the overview; watches:write covers creating, editing, pausing and deleting watches; endpoints:write covers every endpoint change plus event resend and replay. Listing watches and endpoints needs no scope. A missing scope or a blocked IP answers 403 FORBIDDEN; an expired key answers 401 like a revoked one. Sessions are never limited by scopes.
• API key request log. Every request made with a key is written to ApiKeyRequest (method, path without the query string, status, duration, IP) when the response is sent, including requests refused for scope or IP. Rows are pruned after 7 days and deleted with the key. Query strings are never stored because they are developer input and may hold a pasted secret.
• Endpoint event types. Endpoint.eventTypes (default both payment events) is checked together with Watch.eventTypes: an event is created only when the watch and its endpoint both want it. test.ping and system.network_reset are always sent.
• Workspace and email change. Developer.workspace is a display name only. An email change is confirmed from the new address with a stateless signed token (same construction as the password reset token); the token covers the current email, so it stops working once the email changes.
• Status page (added 4 Oct 2026). GET /status is public and returns three components (API, payment detection, webhook delivery) with their state now and their uptime per UTC day for the last 90 days. The worker checks each component once a minute and adds the result to StatusDay (ok / degraded / down counts per day and component): the API by calling its /health over HTTP, detection by the age of the ingestion cursor, delivery by how long the oldest due delivery has waited (up to 60 s is ok, up to 5 min degraded, beyond that down). A day's uptime is (ok + degraded) / checks; a day with no row is shown as "no data", never as up. Rows older than 120 days are pruned.
• Audit log (added 4 Oct 2026). Every successful change to an account is written to AuditLog by the route helper (a route declares `audit: { action }`): account created, logged in, profile, password and email changes, and each API key, endpoint and watch created, changed or deleted, plus event resends and replays. A row holds the action, the target's id and a display label (key name, endpoint URL, watch label), whether a session or an API key did it, the key's id and the IP. It never holds secrets, request bodies or query strings. A row also carries a short `detail` of what the change did ("events: payment.received", "renamed to …"), built from the validated request body of routes that take no secrets. GET /v1/audit-log (session only) lists it newest first with the usual cursor, filtered by `kind` (account, api_key, endpoint, watch, event) and `actor` (session, api_key); logins are left out unless `logins=true`. Failed requests are not recorded; a failed log write is logged and never fails the request. Rows are deleted with the account and are not otherwise pruned.
• Endpoint events in the dashboard. Both payment.received and payment.rejected can be switched off on an endpoint, as long as one stays on (the API has always allowed this; the dashboard used to force payment.received).
• Audit fixes (5 Oct 2026).
  – Matching: a payment whose row already exists is still judged by any eligible watch that has no match for it yet (a watch created just before the payment, which the worker's in-memory list had not loaded). Re-processing stays a no-op because only watches without a match are evaluated.
  – Network reset: a ledger tip more than 100 ledgers behind the cursor must persist for 60 s before it is treated as a reset. A single stale reading from a lagging RPC node no longer rewinds the cursor or notifies endpoints.
  – A watch whose endpoint is deleted records the match but creates no event; resend refuses deliveries to a deleted endpoint with 409. Endpoint event types are looked up once per batch.
  – Fee-bump transactions are locked on both hashes, so RPC (outer hash only) and Horizon always share a lock. Only the retention-gap backfill refreshes the ingestion heartbeat.
  – trust proxy is TRUST_PROXY (1 in production, 0 otherwise) and the API listens on HOST (127.0.0.1 in production): X-Forwarded-For is believed only when a proxy is really in front.
  – Rate limits: refused /v1 requests (401 and 403) count per IP before authentication; sessions and API keys have separate 300/min budgets per developer.
  – API keys: a key that is already rolled or revoked cannot be rolled, and rolling checks the active-key limit.
  – Email change: the token also covers the password hash, so changing or resetting the password cancels a pending change; the current address is told when a change is requested. POST /auth/forgot does not wait for the mailer. Password resets are in the audit log (account.password_reset).
  – Status: delivery health ignores deliveries waiting behind their own endpoint's in-flight sends, so one tenant's slow endpoint is not reported as an outage.
• The 5/min auth rate limit applies to the POST /auth routes that take credentials, not to GET /auth/me or logout.
• Session cookies are Secure only when NODE_ENV=production, so the dashboard works over http://localhost in development.
• The same transaction reaching us from RPC and from the Horizon backfill (different event IDs) is recorded once: the matcher skips a payment whose transaction hash already exists from the other source.
• backfillHours (0–24) moves the watch's startLedger back and sets Watch.backfillPending. The worker (at boot, on watches_changed and every 30 s) first matches payments already recorded for that wallet, then replays the rest from Horizon, and only then clears the flag, so the request survives a restart and is retried after a failure.
• consecutiveFailures only counts an event's 10th attempt. A resend that fails later goes straight back to FAILED without counting again.
• An oversized response body records BODY_TOO_LARGE on the attempt, but the delivery outcome still follows the status code.
• The ingestion heartbeat is also refreshed when a pass fails and backs off: an unreachable RPC raises the lag alert instead of restarting the worker every 60 s.
• Rate limits on /v1: 300/min per developer after authentication, plus 60/min per IP counted only on 401s.
• Text memos are stored with NUL characters removed (Postgres cannot store them, and one such memo would otherwise fail every ingestion batch). Memo bytes that are not exactly 32 long are a non-UTF-8 text memo, never a hash.
• API input containing a NUL character is refused with 400 VALIDATION_FAILED (invalid_character).
• Request logs hold the path only, never the query string, and the Set-Cookie response header is redacted. ?wallet= filters are validated as addresses, so a pasted secret key gets SECRET_KEY_REJECTED.
• After a testnet reset, every watch whose startLedger is above the new tip is moved to the new tip, so watches keep matching on the new chain.
• Live streams are capped at 5 per developer (the oldest is closed) and end when their session does: on logout, and for all other sessions on a password change or reset.
• Watch backfills run one at a time; the cross-source duplicate check holds a per-transaction advisory lock so two sources cannot insert the same payment at once.
• dueDeliveries (health, alerts) excludes deliveries waiting behind a DISABLED endpoint.
• Event IDs recorded after a testnet reset are prefixed with r<reset time>-, because ledger positions (and so raw event IDs) start over on the new network.
• A transfer whose sender is the watched wallet itself (for example a path-payment swap) is not a payment received and is ignored.
• Creating or resuming a watch needs the current ledger. Horizon's tip is used; if Horizon is down, the worker's cursor is extrapolated by its age at 6 s per ledger (never ahead of the real tip); if neither is available the request gets 503.
• Per-developer limits: 20 endpoints, 100 watches, 20 active API keys (409 CONFLICT beyond that). Deleted and revoked ones do not count.
• When a transaction has already left RPC's history, its envelope is fetched from Horizon instead, so a u64 memo is still resolved correctly on late catch-up or reconciliation.
• The Horizon backfill also recovers account merges and claims of claimable balances. Their records carry no amount, so it is read from the operation's effects; claims only appear in the operations feed, which is paged for claims alone. A claim's sender is the balance's B… address, the same as in the live event.
Known limitations
• With every one of the 50 delivery slots held by slow receivers, a new delivery waits for the first slot to free up: at most the 10 s send timeout.
