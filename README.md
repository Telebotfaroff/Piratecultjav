# Telegram Bot Service

A TypeScript/Node.js service with an Express API, React frontend, Telegram bot integration, background jobs, and Supabase PostgreSQL.

## Requirements

- Node.js 22 or newer
- npm
- A Supabase project
- Telegram bot token
- Git

## Configure

Copy `.env.example` to `.env` and configure the values required by your deployment.

Required server-side settings include:

```env
BOT_TOKEN=
SUPABASE_URL=
SUPABASE_SECRET_KEY=
ADMIN_API_KEY= # unique random secret, at least 32 characters
DUMP_CHAT_ID=
ADMIN_IDS=
PORT=3000

# Render uses one trusted reverse-proxy hop by default in production.
# Set TRUST_PROXY_HOPS only when your deployment has a different known proxy chain.
# TRUST_PROXY_HOPS=1

# Recommended on Render: set both to enable Telegram webhook mode
WEBHOOK_URL=https://piratecultjav.onrender.com
WEBHOOK_SECRET=generate-a-strong-random-secret
WEBHOOK_PATH=/telegram-webhook
```

Keep `.env` out of version control. Never expose bot tokens or the Supabase secret key in browser code. `ADMIN_API_KEY` must be a unique random value with at least 32 characters; the service rejects missing, short, or example keys.

## Install and run locally

```bash
npm install
cp .env.example .env
npm run lint
npm run dev
```

The development command runs the TypeScript server and Vite middleware.

## Production build and start

Install dependencies including development dependencies in the build environment, then run:

```bash
npm install
npm run lint
npm run build
NODE_ENV=production npm start
```

The build creates the frontend in `dist/` and bundles the server into `dist-server/server.js`. The production start command runs the compiled server with Node.js, so the production runtime does not depend on the TypeScript runner.

Set the deployment platform's start command to `npm start` and its build command to `npm install && npm run lint && npm run build`.

## Database setup

1. Create a Supabase project.
2. Open the Supabase SQL Editor.
3. Apply the SQL files in `supabase/migrations/` in numeric order.
4. Configure the matching environment variables.
5. Verify that the required tables and database functions exist.

## Indexer worker tuning

The background indexer uses Supabase PostgreSQL for atomic job claiming and renewable leases. Apply migrations `002_retry_recovery.sql` and `023_indexer_worker_leases.sql` before deploying the lease-aware worker. Configure these optional environment variables to tune throughput and recovery:

| Variable | Default | Purpose |
|---|---:|---|
| `INDEXER_CONCURRENCY` | `2` | Concurrent indexing jobs per application instance (1–10) |
| `INDEXER_POLL_INTERVAL_MS` | `4000` | Idle queue polling interval |
| `INDEXER_PROVIDER_DELAY_MS` | `2000` | Delay before each provider request |
| `INDEXER_MAX_ATTEMPTS` | `3` | Maximum attempts before permanent failure |
| `INDEXER_LEASE_SECONDS` | `180` | Renewable job lease duration (60–1800 seconds) |

Each worker slot has a unique owner ID. Jobs are claimed with PostgreSQL `FOR UPDATE SKIP LOCKED`, heartbeats renew active leases, and recovery only requeues expired leases. Increase concurrency gradually and monitor provider rate limits and Supabase load.

## Runtime resilience and graceful shutdown

When both `BOT_TOKEN` and `BACKUP_BOT_TOKEN` are configured, startup validates the selected bot and can fall back to the other token if validation fails. During polling, a runtime launch failure on the primary bot triggers one automatic switch to the backup bot per process. Webhook and polling modes also run a Telegram token-health check every 60 seconds; two consecutive failures can trigger the same one-time primary-to-backup switch. The backup bot must be an administrator in the dump channel and have the same required channel permissions. Keep the primary and backup bot tokens separate and rotate them independently.

On `SIGTERM` or `SIGINT`, the server stops accepting new HTTP connections, removes the active webhook or stops polling, and asks the indexer to finish its claimed jobs before exiting. The shutdown has a 15-second hard timeout; jobs that cannot finish are recovered later through their expired leases.

A runtime failover is intentionally one-way and limited to one attempt per process to avoid flapping. After correcting the primary bot issue, restart the service or manually switch back from the admin controls.


## Supabase read caching

Read-mostly bot configuration uses a small, bounded in-process TTL cache (5 seconds) with single-flight request deduplication. This reduces repeated settings and force-sub configuration reads during bursts of Telegram updates. Successful setting/channel mutations invalidate the corresponding cache immediately. Cache entries are local to each application instance, so external dashboard/database edits become visible within at most the TTL.

Telegram membership checks, blocked-user tracking, premium entitlements, payment processing, and download quota reservations are not cached; those checks continue to use live Telegram/Supabase operations.

## HTTP endpoints

- `/health` — basic process health
- `/ready` — readiness and critical dependency check
- `/api/status` — authenticated service diagnostics

Administrative endpoints require an authenticated admin session or the configured admin API key.

## Linux service example

Create `/etc/systemd/system/telegram-bot-service.service` and replace `YOUR_LINUX_USER` with the account that owns the application files:

```ini
[Unit]
Description=Telegram Bot Service
After=network.target

[Service]
Type=simple
User=YOUR_LINUX_USER
WorkingDirectory=/opt/Piratecultjav
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then run:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot-service
sudo systemctl status telegram-bot-service
```

View logs with:

```bash
sudo journalctl -u telegram-bot-service -f
```

After updating the source, rebuild before restarting:

```bash
cd /opt/Piratecultjav
git pull
npm install
npm run lint
npm run build
sudo systemctl restart telegram-bot-service
```

## Operational notes

- Keep secrets in environment variables.
- Use HTTPS when exposing the service publicly.
- Keep Node.js and dependencies updated.
- On Render, configure `WEBHOOK_URL`, `WEBHOOK_SECRET`, and optionally `WEBHOOK_PATH` to enable Telegram webhook mode. The webhook endpoint defaults to `/telegram-webhook`.
- If webhook variables are absent, the service retains polling mode for local/development compatibility. Do not run polling and webhook mode simultaneously for the same bot token.
- Monitor the readiness endpoint and application logs after deployment.
