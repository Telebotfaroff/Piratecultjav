# PiratecultJAV V2 Architecture

## Goals

V2 separates three runtime responsibilities while preserving the existing Supabase catalog and public website:

1. **Controller bot** — admin-only control plane. It owns admin settings, source configuration, job controls, and User Bot lifecycle management.
2. **User bot** — replaceable public interface for search, user commands, and Telegram delivery. It must not be required for the website or indexing worker to remain available.
3. **Pyrogram historical indexer** — a separate MTProto worker using an administrator-provided user session string to scan historical channel messages and enqueue normalized records.

The existing web/API service remains independently deployable.

## Runtime boundaries

- web: Express API and React application. No Telegram polling loop.
- controller: Telegraf polling for admins only.
- user-bot: Telegraf polling for public users. Exactly one active token at a time.
- historical-indexer: Python/Pyrogram worker. It does not own public bot commands.
- database: shared Supabase PostgreSQL schema and repositories.

The first migration step may keep code in the existing repository and deploy processes with separate start commands. Physical package extraction happens only after runtime boundaries are tested.

## Bot lifecycle

- Controller credentials and active User Bot credentials are separate settings.
- A candidate User Bot token must pass getMe, must not equal the controller token, and must pass configured channel permission checks before activation.
- Activation is transactional: validate candidate, start candidate, verify it is polling, persist active identity, then stop the previous bot. On failure, retain the previous active bot.
- Controller startup and User Bot startup are isolated. A failed User Bot must never stop the controller.
- Persist bot identity/username and role, never expose tokens in logs or admin responses.
- Existing media references are source message references (source_chat_id, source_message_id) wherever possible. file_id is a bot-scoped cache only.

## Historical indexing

Default mode is **all supported media**. The first implementation indexes photos, videos, documents, animations, audio, video notes, voice notes, and captions. Text-only messages can be retained as source metadata only when useful.

Each source has a stable Telegram chat identifier. Each job records:
- source chat and requested range/date filters;
- status (queued, running, paused, completed, failed, cancelled);
- scanned, indexed, duplicate, skipped, and failed counters;
- last processed message ID and resumable checkpoint;
- lease/heartbeat and error summary.

Idempotency key: (source_chat_id, source_message_id). A restarted worker resumes from the last committed checkpoint, not from an in-memory iterator position. Job cancellation is cooperative and checked between messages/batches.

The session string is a secret. It must be encrypted at rest using a separately configured encryption key, redacted from logs, never returned by APIs, and never written into repository files.

## Media identity and delivery

- Canonical identity is the original Telegram message reference, not a file_id.
- Bot-specific file_id values are stored with the bot identity that obtained them.
- User Bot delivery first uses copyMessage from the source channel when that bot has access. If not, return a typed failure; do not silently try a file ID belonging to another bot.
- Screenshot retrieval must use the matching bot reference or a durable media copy. The current implementation's unconditional use of getDeliveryBot() is not valid for legacy file IDs.
- Bot replacement must not rewrite or discard source message records.

## Website

- URL is the source of truth for catalog page and search state (?paged=N&q=...).
- Video detail navigation keeps the prior catalog URL in browser history.
- Browser Back restores page, search, and scroll position.
- API requests are abortable and avoid unnecessary total-count queries on later pages.
- Add caching/lazy loading only with explicit cache invalidation and bounded memory.

## Deployment model

Deploy independent Render services/processes: web/API, controller bot worker, user bot worker, and Pyrogram historical indexer.

All workers use the same Supabase database but have separate process health and restart policies. The web service must not be taken down by Telegram polling or historical indexing failures.

## Migration principles

- Additive Supabase migrations only; do not reset or drop production tables.
- Keep existing videos, screenshot_images, index_jobs, and user data compatible.
- Backfill source-message references before changing delivery reads.
- Roll out behind feature flags/settings where practical.
- Keep main untouched; all V2 work is developed on branch V2.
