# Webhook

Payment webhooks for Stellar Testnet. A developer registers a wallet with payment conditions and
a webhook URL; when someone pays that wallet, Webhook detects the payment, verifies it against the
conditions and delivers a signed event to the developer's app, retrying until it succeeds.

Testnet only. Non-custodial: the service never holds a Stellar secret key or moves funds.

The full spec lives in [docs/](docs/): [build plan](docs/BUILD_PLAN.md),
[architecture](docs/Architecture.md) and [backend](docs/Backend.md).

## What's here

| Path              | What it is                                                                             |
| ----------------- | -------------------------------------------------------------------------------------- |
| `apps/api`        | One codebase, two processes: the REST API (`server.ts`) and the worker (`worker.ts`)   |
| `packages/shared` | Zod schemas, amount helpers and StrKey checks shared with the dashboard                |
| `apps/web`        | The dashboard: landing page, setup flow and every product screen (Next.js static site) |
| `apps/docs`       | Developer docs: guides (Fumadocs) and an API reference (Scalar) generated from the API |
| `scripts`         | Testnet scenario, mock webhook receiver, seed and chaos checks                         |

Server deployment is not set up yet; everything runs locally.

## Local setup

Needs Node 22+, pnpm and Docker.

```sh
pnpm install
docker compose -f docker-compose.dev.yml up -d      # Postgres 16 on localhost:5433
cp apps/api/.env.example apps/api/.env              # then fill in the two secrets below
pnpm --filter @webhook/api db:deploy
```

In `apps/api/.env` set:

- `SESSION_SECRET` to the output of `openssl rand -hex 32`
- `ENCRYPTION_KEY` to the output of `openssl rand -base64 32`
- `ALLOW_INSECURE_WEBHOOK_TARGETS=true` if you want to deliver to the local mock receiver

Run the two processes in separate terminals:

```sh
pnpm --filter @webhook/api dev            # API on http://localhost:4000
pnpm --filter @webhook/api dev:worker     # ingestion + delivery
```

`GET http://localhost:4000/health` should return `{"status":"ok","db":true,...}`.

## Try it

```sh
pnpm --filter @webhook/scripts seed              # demo account, endpoint and watches; prints the API key and secret
WEBHOOK_SECRET=whsec_... pnpm --filter @webhook/scripts mock-receiver   # receiver on http://localhost:4100
pnpm --filter @webhook/scripts scenario          # 20 real testnet payments, asserted end to end
```

The scenario creates Friendbot accounts, sends every kind of payment (normal, wrong asset,
fake-issuer USDC, wrong amount, memo cases, path payment, M-address, issuer mint) and checks that
exactly 20 payments are recorded with the right outcomes and that 20 signed webhooks arrive.

## Dashboard

`apps/web` is the dashboard, a static Next.js site that talks to the API with the session cookie.

```bash
pnpm --filter @webhook/web dev      # http://localhost:3000 (the API must be running on :4000)
pnpm --filter @webhook/web build    # static files in apps/web/out
```

Sign up at `/signup` and the setup flow (`/onboarding`) walks through adding a wallet, an endpoint,
a test webhook and a first payment. Detail pages take their ID from the query string
(`/payments/view?id=…`) because the site is static. Settings it reads at build time:
`NEXT_PUBLIC_API_URL` (default `http://localhost:4000`), `NEXT_PUBLIC_DOCS_URL` and
`NEXT_PUBLIC_ALLOW_INSECURE_TARGETS=true` to accept `http://` endpoint URLs in local development.

## Docs site

`apps/docs` is a static site: six guides written in MDX and an API reference rendered by Scalar
from `openapi.json`, which is generated from the API's own schemas at build time.

```sh
pnpm --filter @webhook/docs dev     # http://localhost:3100
pnpm build:docs                     # static site in apps/docs/out
```

The verification snippet on the "Verifying signatures" page is extracted and run against the real
signer by the API's tests, and every response is checked against the schema shown in the reference.

### The real addresses

The docs point at `https://api.webhookdev.xyz` (API) and `https://webhookdev.xyz` (dashboard).
To change them, run this and commit the result; it updates the quickstart and every code sample:

```sh
pnpm --filter @webhook/docs set-urls https://api.example.com https://app.example.com
```

The same addresses have to be set where each part is deployed:

| Where                        | Setting                | Value                         |
| ---------------------------- | ---------------------- | ----------------------------- |
| API server, `apps/api/.env`  | `DASHBOARD_ORIGIN`     | `https://webhookdev.xyz`      |
| Dashboard build (`apps/web`) | `NEXT_PUBLIC_API_URL`  | `https://api.webhookdev.xyz`  |
| Dashboard build (`apps/web`) | `NEXT_PUBLIC_DOCS_URL` | `https://docs.webhookdev.xyz` |

### Deploying to Cloudflare Pages

Create a Pages project connected to the repository with:

| Setting                | Value                 |
| ---------------------- | --------------------- |
| Build command          | `pnpm build:docs`     |
| Build output directory | `apps/docs/out`       |
| Root directory         | (repository root)     |
| Environment variable   | `NODE_VERSION` = `22` |

Or upload a local build without connecting a repository:

```sh
pnpm build:docs
npx wrangler pages deploy apps/docs/out --project-name webhook-docs
```

## Running with pm2

[ecosystem.config.cjs](ecosystem.config.cjs) runs the API and the worker as two pm2 processes
(`webhook-api`, `webhook-worker`), each reading `apps/api/.env`.

```sh
npm install -g pm2
pnpm build
pnpm --filter @webhook/api db:deploy
pm2 start ecosystem.config.cjs          # add --env production to force NODE_ENV=production
pm2 logs                                # or: pm2 status, pm2 restart webhook-worker
pm2 save && pm2 startup                 # bring both back after a reboot
```

Run exactly one `webhook-worker`. After a code change: `pnpm build && pm2 reload ecosystem.config.cjs`.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test          # needs Docker: integration tests start their own Postgres
```

Every edge case in the spec has a test whose name starts with its ID:
`grep -rhoE '"(W|D|A)[0-9]+:' apps/api/test | sort -u`.

Chaos checks run the scenario while breaking something (build first with `pnpm build`, keep the
API running, stop your own worker):

```sh
scripts/chaos.sh kill-worker           # kill -9 mid-burst
scripts/chaos.sh receiver-down 600     # receiver answers 500 for 10 min
scripts/chaos.sh postgres-down 60      # Postgres stopped for 60 s
scripts/chaos.sh rpc-down 300          # dead RPC host for 5 min
```

## Environment variables

`apps/api/.env.example` lists every variable; a test fails if one read in
`src/config/env.ts` is missing from it. The process refuses to boot on a missing or malformed
value, or on any network passphrase other than testnet's.

| Variable                                             | Notes                                                                              |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`                      | `PORT` defaults to 4000                                                            |
| `DATABASE_URL`                                       | PostgreSQL 16                                                                      |
| `STELLAR_RPC_URL`, `HORIZON_URL`                     | RPC for live events; Horizon for backfill and trustline checks                     |
| `NETWORK_PASSPHRASE`                                 | Must be `Test SDF Network ; September 2015`                                        |
| `USDC_ISSUER`                                        | Circle's testnet issuer                                                            |
| `DASHBOARD_ORIGIN`                                   | CORS allowlist and CSRF check for cookie requests                                  |
| `SESSION_SECRET`                                     | 64+ hex characters; signs password-reset tokens                                    |
| `ENCRYPTION_KEY`                                     | 32 bytes, base64. Encrypts endpoint secrets; losing it means rotating every secret |
| `RESEND_API_KEY`, `EMAIL_FROM`                       | Optional; emails are logged if the key is absent                                   |
| `ALERT_TELEGRAM_BOT_TOKEN`, `ALERT_TELEGRAM_CHAT_ID` | Optional; alerts are logged if absent                                              |
| `MAX_CONCURRENT_DELIVERIES`                          | Webhooks sent at the same time, overall. Default 50                                |
| `HOST`                                               | Address to listen on. Default `127.0.0.1` in production, every interface otherwise |
| `TRUST_PROXY`                                        | Reverse proxies in front of the API. Default 1 in production, 0 otherwise          |
| `SKIP_EMAIL_VERIFICATION`                            | Local runs and scripts only: new accounts skip the emailed code                    |
| `ALLOW_INSECURE_WEBHOOK_TARGETS`                     | Local development only; refused in production                                      |

## API

`pnpm --filter @webhook/api openapi` writes `apps/api/openapi.json`, generated from the same Zod
schemas that validate requests. The dashboard uses a session cookie (`/auth/*`); servers use an
API key: `Authorization: Bearer whk_test_...`.

```sh
curl -X POST localhost:4000/v1/endpoints -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{"url":"https://example.com/webhooks"}'

curl -X POST localhost:4000/v1/watches -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' -d '{
    "walletAddress": "G...", "endpointId": "...",
    "assets": [{"code":"USDC","issuer":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"}],
    "amountRule": {"kind":"min","amount":"10"}, "memoRule": {"kind":"present"}}'
```

## Verifying a webhook

Every request carries `Webhook-Id`, `Webhook-Timestamp`, `Webhook-Attempt` and
`Webhook-Signature: v1=<hex>` (two `v1=` values for 24 h after a secret rotation). The signature
is `HMAC-SHA256(secret, timestamp + "." + rawBody)` in hex. Delivery is at-least-once: dedupe on
`Webhook-Id`.

```js
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhook(secret, headers, rawBody, toleranceSeconds = 300) {
  const timestamp = headers["webhook-timestamp"] ?? "";
  if (
    !/^\d+$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds
  )
    return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest();
  return (headers["webhook-signature"] ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const given = Buffer.from(part.slice(3), "hex");
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
}
```

Retries after a failed attempt: 30 s, 2 min, 10 min, 30 min, 1 h, 3 h, 6 h, 12 h, 24 h (±20%).
After the 10th failure the delivery is `FAILED`; a `410` or 20 failed events in a row disables
the endpoint.
