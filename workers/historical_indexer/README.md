# Historical Indexer Worker

This worker scans historical Telegram channel messages using a dedicated Pyrogram user session. In the Render deployment it runs as an optional, supervised child process inside the same application container as the website and Telegraf bots.

## Required environment

- `DATABASE_URL`: PostgreSQL connection string for the existing Supabase database.
- `API_ID` and `API_HASH`: Telegram application credentials from my.telegram.org.
- `PYROGRAM_SESSION_STRING` (recommended): Pyrogram user session string supplied directly through Render Environment settings. When set, it takes priority and the worker does not query the encrypted session secret.
- `SESSION_ENCRYPTION_KEY` (fallback only): Fernet URL-safe base64 key used to decrypt the session stored in `private_runtime_secrets` under `pyrogram_session_string`, used only when `PYROGRAM_SESSION_STRING` is empty.
- `INDEXER_WORKER_ID` (optional): stable worker label for lease ownership.
- `POLL_INTERVAL_SECONDS` (optional, default 5).
- `BATCH_SIZE` (optional, default 50).
- `ADMIN_IDS` (existing application setting): comma-separated Telegram admin user IDs. Used automatically as historical indexer failure-notification recipients.
- `HISTORICAL_INDEXER_NOTIFY_CHAT_IDS` (optional): overrides `ADMIN_IDS` when a separate notification recipient list is needed. Each recipient must have started a private chat with the Pyrogram account, or the account must be able to message the destination.

The worker never accepts a plaintext session string from command-line arguments and never logs decrypted session material. The controller/admin API must encrypt the session with the same Fernet key before storing it.

## Enable in the single Render service

Set `HISTORICAL_INDEXER_ENABLED=true` after `DATABASE_URL`, `API_ID`, `API_HASH`, and either `PYROGRAM_SESSION_STRING` or the encrypted Supabase session plus `SESSION_ENCRYPTION_KEY` are configured. The Render environment session takes priority. The Docker image installs these Python dependencies; the Node.js server supervises the worker and restarts it with backoff. Leave it disabled during initial deployment if no Pyrogram session has been configured yet.

## Run locally

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r workers/historical_indexer/requirements.txt
python -m workers.historical_indexer.main
```

## Job behaviour

- Default mode is `all`; supported media includes photo, video, document, animation, audio, voice, video note, and sticker.
- Messages are scanned newest-to-oldest. The job checkpoint stores the last committed message ID; resuming uses that ID as an exclusive cursor.
- Message identity is `(source_chat_id, source_message_id)`, so retries do not create duplicate source records.
- Progress and checkpoints are committed in batches. A worker crash can repeat at most the uncommitted batch, which is safe due to the unique key.
- Pause/cancel requests are checked between batches.
- Fatal job errors are saved in `historical_index_jobs.error`, mark the job as `failed`, and trigger a best-effort Telegram notification when `HISTORICAL_INDEXER_NOTIFY_CHAT_IDS` is configured.

The account must already be able to access each configured source channel. This worker only indexes message metadata and Telegram source references; it does not download media files.
