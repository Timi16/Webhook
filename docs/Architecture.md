Architecture
System overview
Webhook is two processes from one codebase (webhook-api and webhook-worker) sharing one PostgreSQL database; the dashboard and docs run on Vercel. The worker is the heart: it reads Stellar, decides, and delivers.
The API never talks to Stellar's event stream and the worker never serves HTTP; they meet only in Postgres, which holds all state and the delivery queue and wakes each side with LISTEN/NOTIFY.
Payment-to-webhook lifecycle
A payment goes from ledger close to a delivered webhook in about 5–10 s, through two database transactions. If the process dies between any two steps, the work is either fully committed or fully redone.
1. Ledger closes on testnet (about every 5 s).
2. Worker polls getEvents every 2 s from the saved cursor, filtered to the topics transfer and mint with a watched wallet as the destination. It never filters by asset contract: a payment in the wrong asset or from a counterfeit issuer must still be seen so it can be REJECTED.
3. Decode and filter. Each event becomes a NormalizedPayment. Anything whose destination (base G address) isn't in the in-memory watched set is dropped.
4. Transaction A (matcher):
    1. If no active Watch on that wallet has startLedger <= ledger, record nothing. Otherwise INSERT ChainPayment … ON CONFLICT (eventId) DO NOTHING. If it already existed, skip the rest for that payment.
    2. For every active Watch on that wallet with startLedger <= ledger: run evaluateWatch and insert a PaymentMatch (unique per payment + watch).
    3. For each VERIFIED match (and each REJECTED match when the watch opted in to payment.rejected): insert a WebhookEvent (unique on matchId) and a Delivery row (PENDING, due now).
    4. Advance the Cursor.
    5. COMMIT, then NOTIFY deliveries and NOTIFY payments.
5. Dispatcher wakes on LISTEN deliveries (and polls every 1 s as a fallback). It claims due rows with FOR UPDATE SKIP LOCKED, sets SENDING, a 60 s lease and attemptCount + 1 (a row re-claimed after a crashed send keeps its attempt number).
6. Send. Load the endpoint's current URL and secret, build headers, sign, POST through the SSRF-safe client.
7. Transaction B (result): insert a DeliveryAttempt; set the delivery to DELIVERED, RETRYING (with nextAttemptAt) or FAILED; update the endpoint's failure counters; COMMIT; NOTIFY deliveries_updated.
8. Dashboard receives the change over Server-Sent Events and updates the payment and delivery views live.
What protects each step
Failure
Protection
Same event seen twice (reconciliation, restart)
ChainPayment.eventId primary key
Same payment evaluated twice for a watch
PaymentMatch @@unique([paymentEventId, watchId])
Two events for one match
WebhookEvent.matchId @unique
Two deliveries of one event to one endpoint
Delivery @@unique([eventId, endpointId])
Crash between match and cursor update
Same transaction: both or neither
Crash after send, before recording result
Lease expires after 60 s → re-sent with the same Webhook-Id → receiver dedupes
Two dispatcher loops claiming the same row
FOR UPDATE SKIP LOCKED
Key design decisions
Each decision below is final for v1; Claude Code should not swap any of them without asking.
Decision
Why
Trade-off accepted
Stellar RPC getEvents as the live source
One event shape (CAP-67) covers payments, path payments and contract-wallet transfers, memo included; Horizon is deprecated
Public RPC keeps a short history, so Horizon is kept for backfill
Postgres as the delivery queue (no Redis, no BullMQ)
Match and queued delivery commit in one transaction, so they can't drift apart; one less service on a 2 GB box
Not built for huge throughput; fine for testnet scale
At-least-once delivery + Webhook-Id dedupe
Exactly-once over HTTP is impossible; this is the industry-standard answer
Receivers must dedupe (documented)
Payload frozen when the event is created
Resends and retries send exactly what was first sent
A rule change doesn't rewrite old events
Amounts as bigint stroops
No float rounding, ever
Conversion helpers needed at the edges
Ledger close time as the time of a payment
Server clocks and lag can't change a result
None
Two processes: api and worker (ingest + dispatch loops)
Isolates HTTP traffic from background work in 2 GB RAM
Worker can be split in two later if needed
Express 5 + Zod + @asteasolutions/zod-to-openapi
One schema validates requests and generates the OpenAPI spec for the docs
Slightly more boilerplate than a code-first framework
Session cookies for the dashboard, API keys for the API
Cookies are safest for browsers; keys are standard for server-to-server
Two auth paths to test
Endpoint secrets encrypted (AES-256-GCM), API keys hashed (SHA-256)
We must read secrets to sign; we never need to read API keys back
Losing ENCRYPTION_KEY means rotating every secret
Server-Sent Events for live dashboard updates
One-way updates only; simpler than WebSockets and passes through Caddy untouched
No client-to-server messages (not needed)
In-memory rate limits (express-rate-limit)
Single API instance
Must move to a shared store if the API is ever scaled out
Data model
The full Prisma schema for v1. The unique constraints are part of the design, not optional: they are what makes duplicate payments and duplicate webhooks impossible.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Developer {
  id           String     @id @default(cuid())
  email        String     @unique
  passwordHash String
  name         String?
  createdAt    DateTime   @default(now())
  sessions     Session[]
  apiKeys      ApiKey[]
  endpoints    Endpoint[]
  watches      Watch[]
  events       WebhookEvent[]
}

model Session {
  id          String    @id // sha256 of the cookie token, never the token itself
  developerId String
  developer   Developer @relation(fields: [developerId], references: [id], onDelete: Cascade)
  expiresAt   DateTime
  createdAt   DateTime  @default(now())
  ip          String?
  userAgent   String?

  @@index([developerId])
}

model ApiKey {
  id          String    @id @default(cuid())
  developerId String
  developer   Developer @relation(fields: [developerId], references: [id], onDelete: Cascade)
  name        String
  prefix      String    // e.g. "whk_test_9f2a" shown in the UI
  keyHash     String    @unique // sha256 of the full key
  lastUsedAt  DateTime?
  revokedAt   DateTime?
  createdAt   DateTime  @default(now())

  @@index([developerId])
}

enum EndpointStatus {
  ACTIVE
  FAILING
  DISABLED
}

model Endpoint {
  id                  String         @id @default(cuid())
  developerId         String
  developer           Developer      @relation(fields: [developerId], references: [id], onDelete: Cascade)
  url                 String
  description         String?
  secretEnc           String         // base64(iv | authTag | ciphertext), AES-256-GCM
  prevSecretEnc       String?        // one encrypted secret, or a JSON list of { enc, until } after overlapping rotations
  prevSecretUntil     DateTime?
  status              EndpointStatus @default(ACTIVE)
  consecutiveFailures Int            @default(0) // failed EVENTS in a row, not attempts
  disabledReason      String?
  deletedAt           DateTime?
  createdAt           DateTime       @default(now())
  updatedAt           DateTime       @updatedAt
  watches             Watch[]
  deliveries          Delivery[]

  @@index([developerId])
}

model Watch {
  id              String         @id @default(cuid())
  developerId     String
  developer       Developer      @relation(fields: [developerId], references: [id], onDelete: Cascade)
  endpointId      String
  endpoint        Endpoint       @relation(fields: [endpointId], references: [id])
  walletAddress   String         // base G address only
  label           String?
  assets          Json           // [{ code: "USDC", issuer: "G..." }, { code: "XLM", issuer: null }]
  amountRule      Json           // { kind: "any" } | { kind: "exact", stroops } | { kind: "min" | "max", stroops } | { kind: "range", min, max }
  memoRule        Json           // { kind: "any" | "present" | "absent" } | { kind: "equals", value, type }
  senderAllowlist String[]
  eventTypes      String[]       @default(["payment.received"])
  startLedger     Int
  backfillPending Boolean        @default(false) // set by backfillHours; cleared by the worker when done
  active          Boolean        @default(true)
  deletedAt       DateTime?
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
  matches         PaymentMatch[]

  @@index([walletAddress, active])
  @@index([developerId])
}

model ChainPayment {
  eventId        String         @id // RPC event id, globally unique
  txHash         String
  innerTxHash    String?        // set for fee-bump transactions
  ledger         Int
  ledgerClosedAt DateTime
  fromAddress    String
  toAddress      String         // base G address
  toMuxedId      String?
  memo           String?
  memoType       String         // "none" | "text" | "id" | "hash"
  assetCode      String
  assetIssuer    String?        // null = native XLM
  amountStroops  BigInt
  eventType      String         // "transfer" | "mint"
  source         String         // "rpc" | "horizon"
  createdAt      DateTime       @default(now())
  matches        PaymentMatch[]

  @@index([toAddress, ledger])
  @@index([txHash])
  @@index([innerTxHash])
}

enum MatchOutcome {
  VERIFIED
  REJECTED
}

model PaymentMatch {
  id             String        @id @default(cuid())
  paymentEventId String
  payment        ChainPayment  @relation(fields: [paymentEventId], references: [eventId])
  watchId        String
  watch          Watch         @relation(fields: [watchId], references: [id])
  outcome        MatchOutcome
  reasons        String[]      // e.g. ["WRONG_ISSUER"], empty when VERIFIED
  createdAt      DateTime      @default(now())
  event          WebhookEvent?

  @@unique([paymentEventId, watchId])
  @@index([watchId, createdAt])
}

model WebhookEvent {
  id          String        @id // "evt_" + ULID, generated in code
  developerId String
  developer   Developer     @relation(fields: [developerId], references: [id], onDelete: Cascade)
  matchId     String?       @unique // null only for test.ping and system events
  match       PaymentMatch? @relation(fields: [matchId], references: [id])
  type        String        // "payment.received" | "payment.rejected" | "test.ping" | "system.network_reset"
  payload     Json          // frozen at creation
  createdAt   DateTime      @default(now())
  deliveries  Delivery[]

  @@index([developerId, createdAt])
}

enum DeliveryStatus {
  PENDING
  SENDING
  DELIVERED
  RETRYING
  FAILED
  CANCELLED
}

model Delivery {
  id             String            @id @default(cuid())
  eventId        String
  event          WebhookEvent      @relation(fields: [eventId], references: [id], onDelete: Cascade)
  endpointId     String
  endpoint       Endpoint          @relation(fields: [endpointId], references: [id])
  status         DeliveryStatus    @default(PENDING)
  attemptCount   Int               @default(0)
  nextAttemptAt  DateTime          @default(now())
  leaseUntil     DateTime?
  lastStatusCode Int?
  lastError      String?
  deliveredAt    DateTime?
  createdAt      DateTime          @default(now())
  updatedAt      DateTime          @updatedAt
  attempts       DeliveryAttempt[]

  @@unique([eventId, endpointId])
  @@index([status, nextAttemptAt])
  @@index([endpointId, status])
}

model DeliveryAttempt {
  id              String   @id @default(cuid())
  deliveryId      String
  delivery        Delivery @relation(fields: [deliveryId], references: [id], onDelete: Cascade)
  number          Int
  startedAt       DateTime
  durationMs      Int
  statusCode      Int?
  error           String?  // "TIMEOUT" | "DNS" | "CONN_REFUSED" | "TLS" | "SSRF_BLOCKED" | "REDIRECT" | "BODY_TOO_LARGE"
  responseSnippet String?  // first 1 KB, stored as plain text
  createdAt       DateTime @default(now())

  @@unique([deliveryId, number])
}

model Cursor {
  name               String    @id // "rpc-events"
  ledger             Int
  pagingToken        String?
  networkPassphrase  String
  lastNetworkResetAt DateTime?
  updatedAt          DateTime  @updatedAt
}
Notes for implementation:
• Watch.assets, amountRule and memoRule are validated with the shared Zod schemas on every write and parsed with them on every read; never trust raw JSON from the database.
• Soft-deleted watches (deletedAt set) stop matching immediately but keep their history.
• Resend reuses the same Delivery row (reset to PENDING), so the Webhook-Id never changes for an event.
• Endpoints are soft-deleted too (deletedAt set, status DISABLED, disabledReason DELETED): deliveries and attempts keep their history, and the dispatcher never claims for them.
• Endpoint.description and Endpoint.deletedAt were added during the build (additive migrations) because the API contract needs them.
Delivery state machine
Each Delivery row moves through six states; only the dispatcher and the Resend/Replay/Delete controls may change it, and every change happens in a transaction.
Two transitions aren't drawn: a SENDING row whose 60 s lease expires is claimed again as if due (crash recovery), and Resend also works on a DELIVERED event. Deleting an endpoint cancels its PENDING and RETRYING rows too.
Endpoint status
From
To
When
ACTIVE
FAILING
Any attempt fails
FAILING
ACTIVE
Any 2xx
ACTIVE / FAILING
DISABLED
A 410 response, or 20 events in a row end FAILED
DISABLED
ACTIVE
Developer clicks Enable (consecutiveFailures reset; nothing replayed automatically)
The dispatcher never claims deliveries for a DISABLED endpoint; they wait until it's re-enabled or the developer uses Replay.
Security architecture
Webhook never holds a Stellar secret key or moves funds, so the worst case is leaked data, not stolen money. The two highest risks are tenant leakage (one developer seeing another's data) and SSRF (our dispatcher being pointed at internal addresses); both have dedicated controls and tests.
Checklist
Accounts and access
[ ] Passwords: argon2id, minimum 10 characters, checked against a short common-password list
[ ] Sessions: 32-byte random token in an httpOnly, Secure, SameSite=Lax cookie; only its SHA-256 stored; 14-day expiry; rotated on login
[ ] CSRF: every state-changing cookie-auth request must carry an Origin header matching DASHBOARD_ORIGIN
[ ] Login: 5 attempts/min per IP plus growing delay per account; same error for wrong email or wrong password
[ ] API keys: whk_test_ + 32 random bytes (base62), shown once, SHA-256 stored, revocable, lastUsedAt updated at most once a minute
[ ] Tenant isolation: every Prisma query on tenant data goes through a repository function that requires developerId; tests prove cross-tenant access returns 404
Input and output
[ ] Zod on every body, query and param (.strict() so unknown fields are rejected)
[ ] Wallet addresses: StrKey.isValidEd25519PublicKey; strings starting with S and passing StrKey.isValidEd25519SecretSeed are refused with a warning and never logged
[ ] Amounts: regex ^\d{1,12}(\.\d{1,7})?$, then to bigint stroops; > 0
[ ] Response snippets from developer endpoints are stored and shown as plain text only
Webhook delivery (SSRF)
[ ] URL must be https:, no credentials in the URL, port 443 or 8443 only
[ ] Custom undici connect hook: resolve DNS, reject private, loopback, link-local, CGNAT, multicast, unspecified and IPv4-mapped IPv6 ranges, then connect to that exact IP (stops DNS rebinding)
[ ] Checked at save time AND at every send
[ ] 10 s total timeout, redirects never followed, response read capped at 64 KB
[ ] Secrets: AES-256-GCM with a random 12-byte IV per secret; ENCRYPTION_KEY (32 bytes) only in env
HTTP hardening (Express)
[ ] helmet with HSTS, noSniff, frameguard: deny, strict referrerPolicy
[ ] cors allowlist = dashboard origin only, credentials: true
[ ] express.json({ limit: "100kb" }); app.disable("x-powered-by"); trust proxy set to 1 (behind Caddy)
[ ] Rate limits: 60/min per IP on public routes, 300/min per API key, 5/min on auth
Logs, secrets, dependencies
[ ] pino redact: req.headers.authorization, req.headers.cookie, *.password, *.secret, *.apiKey
[ ] .env never committed; .env.example kept current
[ ] Lockfile committed; pnpm audit in CI; Dependabot on
Server
[ ] UFW: 22, 80, 443 only; SSH keys only, root login off, fail2ban, unattended-upgrades
[ ] Postgres only on the internal Docker network, never published
Infrastructure and deployment
The backend runs as two containers on the shared InterServer slice (1 core, 2 GB RAM, 40 GB SSD); the dashboard and docs run on Vercel's free tier. Nothing is compiled on the server.
Containers (Webhook's share of the server)
Container
Memory limit
Runs
webhook-api
256 MB
Express API + SSE (node --max-old-space-size=192)
webhook-worker
256 MB
Ingestion, reconciliation, watchdog and dispatcher loops
postgres (shared with PayLink)
384 MB
Separate webhooks database and DB user
caddy (shared)
64 MB
HTTPS + reverse proxy
Every container: restart: unless-stopped, a healthcheck, and Docker log rotation (max-size=10m, max-file=3). A 2 GB swap file is the safety net.
Domains
Address
Serves
webhook.<domain>
Dashboard (Vercel)
docs.webhook.<domain>
Docs site (Vercel)
api.webhook.<domain>
Caddy → webhook-api
Deploy pipeline
1. Push to main → GitHub Actions: install, lint, typecheck, test (with a Postgres service container).
2. Build the API/worker image (one image, two start commands) and push to GitHub Container Registry tagged with the commit SHA.
3. SSH in with a deploy-only key: prisma migrate deploy, then docker compose pull && docker compose up -d.
4. Poll /health for 60 s; on failure, redeploy the previous SHA and fail the job.
5. Vercel deploys apps/web and apps/docs on its own from the same push.
Migrations stay additive during the build (add, never rename or drop), so a rollback never meets a schema it can't read.
Monitoring and backups
• /health returns DB status, last processed ledger, ingestion lag (s), due-delivery count. UptimeRobot checks it every 5 min.
• The worker posts to a Telegram bot when: lag > 60 s for 2 min, a testnet reset is detected, failure rate across 3+ endpoints > 50% in 15 min, or due deliveries > 1,000.
• Nightly cron: pg_dump webhooks → gzip → encrypt → copy off the server; keep 7 days; one restore tested before handover.