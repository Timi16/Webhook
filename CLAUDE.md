# Webhook

Stellar Testnet payment webhook service. Read everything in /docs before starting any task.

## Current scope (agreed 3 Oct 2026)

- Backend only for now: `apps/api` and `packages/shared`. No dashboard or docs site yet.
- Local development only. Skip server setup, CI deploy and anything else that needs the live server.
- Package manager is pnpm. Where the docs say `npm run <script>`, use `pnpm <script>` from the repo root.

## Working rules

1. Follow the docs. If something is unclear or seems wrong, ask before building. If we agree to change the design, update the matching doc in the same commit.
2. Work one phase at a time, in order. A phase is done only when its gate check passes.
3. TypeScript strict everywhere. No `any`, no `@ts-ignore` without a comment explaining why.
4. Money is never a float. Amounts are bigint stroops in code, BigInt columns in Postgres, strings in JSON. `parseFloat` and `Number()` on amounts are banned.
5. Any write that touches payments, matches, events or deliveries happens inside one Prisma transaction.
6. Every edge-case ID in these docs (W1–W15, D1–D16, A1–A4) gets at least one test whose name starts with that ID.
7. Never log secrets: passwords, API keys, webhook secrets, encryption keys, full Authorization headers.
8. Testnet only. Read the network passphrase from env and refuse to boot if it isn't the testnet passphrase.
9. Before saying a task is done, run `pnpm lint`, `pnpm typecheck` and `pnpm test`, and report the results.
10. Small, focused commits using conventional commit messages (`feat:`, `fix:`, `test:`, `docs:`).

## Local setup

```sh
pnpm install
docker compose -f docker-compose.dev.yml up -d   # Postgres 16 on localhost:5433
cp apps/api/.env.example apps/api/.env
pnpm --filter @webhook/api db:migrate
pnpm --filter @webhook/api dev                   # http://localhost:4000/health
```

Tests need Docker running: integration tests start their own Postgres with Testcontainers.
