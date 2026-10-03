Webhook — Build Plan & Architecture
3 Oct 2026 · @Timmy
How to use this with Claude Code
This doc is the full spec for Webhook, the Stellar Testnet payment webhook service: this Build Plan tab plus Architecture, Backend and Frontend. Export each tab to Markdown and commit them to the repo so Claude Code reads them every session.
Repo setup
File in repo
Comes from
docs/BUILD_PLAN.md
This tab
docs/ARCHITECTURE.md
Architecture tab
docs/BACKEND.md
Backend tab
docs/FRONTEND.md
Frontend tab
CLAUDE.md (repo root)
The working rules below, plus one line: "Read everything in /docs before starting any task."
First message to Claude Code: "Read CLAUDE.md and everything in /docs. Ask me any questions you have, then start Phase 0 of BUILD_PLAN.md. Stop at the end of each phase and show me the gate check results."
Working rules for Claude Code (paste into CLAUDE.md)
1. Follow the docs. If something is unclear or seems wrong, ask before building. If we agree to change the design, update the matching doc in the same commit.
2. Work one phase at a time, in order. A phase is done only when its gate check passes.
3. TypeScript strict everywhere. No any, no @ts-ignore without a comment explaining why.
4. Money is never a float. Amounts are bigint stroops in code, BigInt columns in Postgres, strings in JSON. parseFloat and Number() on amounts are banned.
5. Any write that touches payments, matches, events or deliveries happens inside one Prisma transaction.
6. Every edge-case ID in these docs (W1–W15, D1–D16, A1–A4) gets at least one test whose name starts with that ID.
7. Never log secrets: passwords, API keys, webhook secrets, encryption keys, full Authorization headers.
8. Testnet only. Read the network passphrase from env and refuse to boot if it isn't the testnet passphrase.
9. Before saying a task is done, run npm run lint, npm run typecheck and npm test, and report the results.
10. Small, focused commits using conventional commit messages (feat:, fix:, test:, docs:).
Scope and end result
A developer registers a Stellar Testnet wallet with payment conditions and a webhook URL; when someone pays that wallet, Webhook detects the payment, verifies it, and delivers a signed event to the developer's app, retrying until it succeeds.
End-to-end flow
1. Developer signs up, creates an API key, adds a wallet ("watch") with conditions and an endpoint URL.
2. Someone sends a payment to that wallet on testnet.
3. The monitoring worker picks it up from Stellar RPC within seconds of the ledger closing.
4. The verifier checks wallet, asset + issuer, amount, memo and sender against the watch's conditions.
5. A verified payment creates one webhook event; the dispatcher signs it and POSTs it to the endpoint.
6. The developer's app verifies the signature and processes the payment; every attempt shows on the dashboard.
Deliverables
#
Deliverable
Phases
1
Stellar Payment Monitoring: watch wallets, detect payments, verify conditions
0, 1
2
Webhook Engine: signed delivery, status, retries, no duplicates
2, 3
3
Developer Dashboard & API Docs
4, 5
—
Hardening, deployment and handover
6
Decisions already made
• Backend: Node.js + Express + TypeScript, Prisma, PostgreSQL. No Redis: one API instance, so rate limits live in memory and the delivery queue lives in Postgres.
• Frontend: Next.js dashboard; docs site on Fumadocs with a Scalar API reference generated from the OpenAPI spec.
• Stellar data: Stellar RPC getEvents (live), Horizon only for backfill.
• Assets: USDC (Circle testnet issuer GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5), XLM, and custom code + issuer.
• Login: email + password. Developer emails only when an endpoint is disabled.
• Non-custodial: the service never holds a Stellar secret key or moves funds.
Out of scope
Mainnet, an admin panel, a client SDK (a verifyWebhook snippet in the docs covers it), and anything not listed in the phases below.
Phases and tasks
Seven phases in build order, each ending in a gate check that must pass before the next phase starts. The schedule fits the agreed 7-day window (days 3–4 go to PayLink).
Day
Phases
1
Phase 0 — Foundation
2
Phase 1 — Stellar monitoring
5
Phase 2 — Accounts and core API · Phase 3 — Webhook engine
6
Phase 4 — Dashboard · Phase 5 — Docs site
7
Phase 6 — Harden and hand over
Phase 0 — Foundation
[ ] pnpm workspace: apps/api (Express), apps/web (Next.js), apps/docs (Fumadocs), packages/shared (Zod schemas + types shared by API and web)
[ ] TypeScript strict, ESLint (including a rule banning parseFloat/Number() on amount fields), Prettier, Vitest
[ ] docker-compose.dev.yml with Postgres 16
[ ] Prisma schema from the Architecture tab + first migration
[ ] Express skeleton with /health, request IDs, pino logging, error handler, env validation at boot
[ ] GitHub Actions: lint → typecheck → test → build image → push to GHCR → deploy over SSH
[ ] Server: hardening, Docker, Caddy with HTTPS, swap, log rotation, nightly backup cron
[ ] Design direction picked; tokens written to apps/web/DESIGN.md
Gate: a push to main deploys, and https://api.<domain>/health returns 200 with DB status.
Phase 1 — Stellar monitoring (Deliverable 1)
[ ] 1-hour spike: send a payment, path payment and contract-wallet transfer on testnet; confirm getEvents returns each with amount, asset and memo
[ ] StellarSource interface with RpcEventSource (live) and HorizonBackfillSource
[ ] Event decoder → NormalizedPayment; muxed (M-address) handling; memo normalisation
[ ] amount.ts: string ↔ bigint stroops, 7-decimal formatting, full test coverage
[ ] Pure evaluateWatch(payment, watch) → { outcome, reasons[] }
[ ] Ingestion loop: poll, decode, filter by watched set, one transaction per batch, advance cursor
[ ] Watched-set cache refreshed via Postgres LISTEN/NOTIFY
[ ] Reconciliation every 2 min, watchdog (lag > 60 s), testnet-reset detection
[ ] Tests W1–W15
[ ] scripts/scenario.ts: Friendbot accounts, trustlines, fake-issuer USDC, test payments
Gate: scenario sends 20 payments → exactly 20 ChainPayment rows with correct outcomes; kill -9 on the worker mid-run, restart → still exactly 20.
Phase 2 — Accounts and core API
[ ] Sign up, log in, log out, session cookies, argon2id, login rate limit
[ ] API keys: create (shown once), list, revoke; Bearer auth middleware
[ ] Watches CRUD with full validation (StrKey, secret-key refusal, rule schemas, trustline check)
[ ] Endpoints CRUD with HTTPS-only and SSRF validation; encrypted secrets
[ ] GET /v1/payments with filters and cursor pagination
[ ] OpenAPI spec generated from the Zod schemas
[ ] Tests A1–A4 and tenant isolation (developer A gets 404 on everything of developer B's)
Gate: a developer can be created and a watch + endpoint registered purely via API, and every endpoint appears in the OpenAPI spec.
Phase 3 — Webhook engine (Deliverable 2)
[ ] Matcher creates WebhookEvent + Delivery rows in the same transaction as the match
[ ] Payload builder (frozen JSON, api_version) + HMAC signer
[ ] Dispatcher loop: claim with FOR UPDATE SKIP LOCKED, leases, per-endpoint concurrency of 5
[ ] SSRF-safe HTTP client: resolve, check IP, connect to that IP, 10 s timeout, no redirects, 64 KB cap
[ ] Retry schedule with jitter; 410 handling; auto-disable after 20 failed events in a row + email
[ ] Resend, test ping, secret rotation with 24 h grace, replay failed since a date
[ ] Mock receiver (scripts/mock-receiver.ts) scriptable for 200/500/timeout/redirect/410
[ ] Tests D1–D16
Gate: testnet payment → webhook received and signature verified by the docs snippet; receiver down 10 min → delivered once it's back; re-running reconciliation → no second event.
Phase 4 — Dashboard (Deliverable 3)
[ ] All screens in the Frontend tab, wired to the real API
[ ] Live updates via SSE for payments and deliveries
[ ] Empty, loading, error states; mobile down to 360 px; light + dark
Gate: a new account goes from sign-up to a received test webhook using only the dashboard.
Phase 5 — Docs site (Deliverable 3)
[ ] Fumadocs site: Quickstart, Webhook reference, Verifying signatures, Retries and duplicates, Testnet guide
[ ] Scalar API reference from the OpenAPI spec
[ ] Copy-paste Node.js verification snippet, tested against the real signer
Gate: someone who hasn't seen the project integrates a test endpoint in under 15 minutes using only the docs.
Phase 6 — Harden and hand over
[ ] Chaos tests (Backend tab) all pass
[ ] Security checklist (Architecture tab) fully ticked
[ ] UptimeRobot + Telegram alerts live; backup restore tested once
[ ] README: local setup, env vars, deploy, runbook
[ ] Full scenario run on the live deployment as the demo for David
Gate: Definition of done below is fully ticked.
Definition of done
Webhook is done when every box below is ticked on the live deployment, not just locally.
[ ] All three deliverables pass their phase gates
[ ] Every edge-case ID (W1–W15, D1–D16, A1–A4) has a passing test named with its ID
[ ] npm run lint, typecheck and test are green in CI on main
[ ] Live testnet demo: register wallet → pay → webhook received and verified, end to end
[ ] Chaos tests pass: no payment missed or double-counted, no event lost
[ ] Security checklist fully ticked
[ ] HTTPS, monitoring, alerts and nightly off-server backups running; one restore tested
[ ] Docs site live with Quickstart, webhook reference, signature verification and API reference
[ ] Handover: repo access, README, env var list, runbook, admin credentials shared securely
Bug fixes are free for 60 days after handover; new features and server management are billed separately.