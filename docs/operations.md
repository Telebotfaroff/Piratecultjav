# Production operations

## Health endpoints

- `GET /health` is the liveness probe. It confirms that the HTTP process is responding.
- `GET /ready` is the readiness probe. It checks configuration, Supabase connectivity, and bot runtime state.
- `GET /api/status` is admin-authenticated and includes database latency, record counts, worker status, and bounded HTTP metrics.
- `GET /api/metrics` is admin-authenticated and returns request counts, 5xx counts, route-level average/maximum latency, status codes, latency buckets, and indexer outcome counters.

HTTP metrics are held in process memory and reset on restart. Route labels use Express route templates or normalized paths, not query strings or user identifiers. For multi-instance deployments, collect each instance's JSON logs and metrics separately or forward them to a central observability service.

## Scheduled deployment checks

The `Deployment Health Check` workflow runs every 15 minutes and can also be started manually.

Set the repository Actions secret `SERVICE_BASE_URL` to the public base URL of the deployed service (for example, `https://your-service.example.com`). The workflow checks both `/health` and `/ready`. If the secret is absent, the workflow reports a notice and skips the check. GitHub Actions failure notifications can be enabled in the repository notification settings.

Run the same check locally with:

```bash
SERVICE_BASE_URL=https://your-service.example.com npm run health:check
```

## Structured logs

The server emits JSON log records for HTTP 5xx responses and indexer loop, lease-heartbeat, retry, completion, and terminal-failure events. Useful fields include `timestamp`, `level`, `event`, `jobId`, `statusCode`, and `durationMs`. Avoid adding bot tokens, API keys, Telegram file IDs, or user message contents to log context.

## Database migration verification

CI runs `npm run check:migrations` before unit tests and the production build. It checks migration file naming, empty files, duplicate version prefixes, and required access-control statements in migration 027.

The existing migration set has legacy duplicate prefixes 004 and 005. They are reported as warnings so current CI remains usable, but the migration history must be reconciled before using automated CLI ordering on a fresh or production database.

Migration 027 explicitly grants the server-only `service_role` access to application tables, sequences, and RPC functions; revokes table/sequence/function access from `anon` and `authenticated`; enables RLS on public tables; and sets default privileges for future migrations. This is important because Supabase's October 30, 2026 rollout requires explicit grants for new public tables exposed through the Data API. See the [Supabase change notice](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically).

## Current Supabase target verification

The Supabase project currently visible to the connected account reports zero public tables and an empty migration history, while this application expects tables such as `users`, `videos`, `index_jobs`, and `bot_settings`. Do not apply migrations until the correct project is confirmed and its schema/migration state is reviewed. Run Supabase security and performance advisors after applying the reconciled migration set.
