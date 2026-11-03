# PiratecultJAV V2 Implementation Roadmap

## Phase 0 — Baseline and safety
- [x] Create isolated V2 branch from main.
- [x] Document target architecture and migration rules.
- [x] Additive historical-indexing schema foundation (migration 029).
- [ ] Record current database migration head and production schema.
- [ ] Add CI checks for TypeScript, tests, migrations, and Python worker.

## Phase 1 — Web navigation and in-app runtime isolation
- [x] Make catalog page/search state URL-backed.
- [x] Restore catalog URL and scroll position after video details Back.
- [x] Keep one Render application entry point; isolate controller and User Bot startup within it.
- [x] Make controller and User Bot startup failures independent.
- [x] Add separate controller and delivery status reporting to /health.

## Phase 2 — Bot configuration and delivery identity
- [ ] Add secure controller/User Bot configuration service.
- [ ] Implement validate → start → verify → activate → stop-old replacement flow.
- [ ] Store bot identity with bot-scoped file references.
- [ ] Prefer source chat/message references for video delivery.
- [ ] Fix screenshot retrieval to select the bot that owns the reference.
- [ ] Add typed diagnostics for source-channel vs destination-chat failures.

## Phase 3 — Historical indexing
- [x] Add additive Supabase schema for sources, jobs, checkpoints, and source message references.
- [x] Add initial Python/Pyrogram worker and dependency lock.
- [ ] Validate session and channel access.
- [ ] Index all supported media by default.
- [ ] Add idempotency, checkpoints, leases, retry/backoff, pause/resume/cancel.
- [ ] Encrypt session string at rest and redact logs.

## Phase 4 — Admin controls
- [ ] Add Pyrogram session settings.
- [ ] Add source channel management.
- [ ] Add Index Old Files button and job progress screen.
- [ ] Add range/date filters and selective media filters.
- [ ] Add job logs, retries, and cancellation.

## Phase 5 — Website performance
- [ ] Profile API/database queries and add only evidence-based indexes.
- [ ] Add bounded caching and cache invalidation.
- [ ] Optimize thumbnail loading and details-page data reuse.
- [ ] Add navigation and pagination regression tests.

## Phase 6 — Single-service Render deployment and cutover
- [x] Add one Render Web Service Blueprint and Docker image for the combined Node.js + Python application.
- [x] Add an opt-in supervised Pyrogram child process with restart backoff and graceful shutdown.
- [ ] Run shadow indexing on a small source before bulk history scans.
- [ ] Verify duplicate handling and checkpoint recovery.
- [ ] Test User Bot replacement and rollback.
- [ ] Test website while both Telegram workers are stopped.
- [ ] Promote V2 only after integration tests pass.

## Non-negotiable safety rules
- Never reset production Supabase.
- Never commit bot tokens or Pyrogram session strings.
- Never make the controller depend on User Bot availability.
- Never treat a bot-specific file_id as a cross-bot media identifier.
- Do not bulk-index until a small test run and resume test pass.
