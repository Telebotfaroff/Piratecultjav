# PiratecultJAV V2 Architecture

## Goals

V2 separates three runtime responsibilities while preserving the existing Supabase catalog and public website:

1. **Controller bot** — admin-only control plane. It owns admin settings, source configuration, job controls, and User Bot lifecycle management.
2. **User bot** — replaceable public interface for search, user commands, and Telegram delivery. It must not be required for the website or indexing worker to remain available.
3. **Pyrogram historical indexer** — a separate MTProto worker using an administrator-provided user session string to scan historical channel messages and enqueue normalized records.

All components ship together as one Render Web Service and one Docker container. Runtime responsibilities remain logically isolated inside that single application.

## Runtime boundaries

These are logical components, not separate Render services:

- web/API: Express API and React application, hosted by the same Node.js server.
- controller: Telegraf polling for admins only.
- user-bot: Telegraf polling for public users. Exactly one active token at a time.
- Node.js indexer: existing background queue worker in the Node.js process.
- historical-indexer: optional Python/Pyrogram child process supervised by the Node.js server.
- database: shared Supabase PostgreSQL schema and repositories.

Render runs one Web Service, one Docker container, and one deployment. Controller and User Bot startup failures are isolated from one another; a Pyrogram child-process failure is restarted independently and must not terminate the HTTP server or Telegram bots.

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

Deploy exactly one Render Web Service from the repository's `render.yaml` using the included Dockerfile. The container runs the Express/React application, both Telegraf bots using long polling, and the existing Node.js indexer. When explicitly enabled and fully configured, the Python/Pyrogram historical indexer runs as a supervised child process in the same container.

The HTTP server remains the primary process and owns graceful shutdown. Bot startup failures are isolated; the Pyrogram worker has its own restart backoff. Render health checks use `/health`. Do not create separate Render services for individual components.

## Migration principles

- Additive Supabase migrations only; do not reset or drop production tables.
- Keep existing videos, screenshot_images, index_jobs, and user data compatible.
- Backfill source-message references before changing delivery reads.
- Roll out behind feature flags/settings where practical.
- Keep main untouched; all V2 work is developed on branch V2.
