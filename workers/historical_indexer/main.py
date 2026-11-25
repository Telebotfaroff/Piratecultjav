from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import signal
import socket
import uuid
from datetime import datetime, timezone
from typing import Any, Mapping

import asyncpg
from cryptography.fernet import Fernet
from pyrogram import Client
from pyrogram.types import Message
try:
    from .telegram_auth import TelegramAuthManager
except ImportError:
    from telegram_auth import TelegramAuthManager

LOG = logging.getLogger("piratecult.historical_indexer")
MEDIA_ATTRIBUTES = {
    "photo": "photo",
    "video": "video",
    "document": "document",
    "animation": "animation",
    "audio": "audio",
    "voice": "voice",
    "video_note": "video_note",
    "sticker": "sticker",
}
CODE_PATTERN = re.compile(r"\b(?:FC2[-_]?\d{5,8}|[A-Z]{2,6}[-_]?\d{2,5})\b", re.IGNORECASE)
PART_PATTERN = re.compile(r"\b(?:part|pt|cd|disc|disk)\s*[-_.#]?\s*(\d{1,2})(?:\s*(?:of|/)\s*(\d{1,2}))?\b", re.IGNORECASE)


def required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value


def resolve_session_string(environ: Mapping[str, str], encrypted_value: str | None) -> tuple[str, str]:
    """Prefer the database session so an admin can rotate the connected account."""
    encryption_key = environ.get("SESSION_ENCRYPTION_KEY", "").strip()
    if encrypted_value:
        if not encryption_key:
            raise RuntimeError("Missing SESSION_ENCRYPTION_KEY for the encrypted Supabase Pyrogram session.")
        try:
            decrypted = Fernet(encryption_key.encode()).decrypt(encrypted_value.encode()).decode()
        except Exception as exc:
            raise RuntimeError("Could not decrypt the configured Supabase Pyrogram session.") from exc
        return decrypted, "supabase"
    session_string = environ.get("PYROGRAM_SESSION_STRING", "").strip()
    return (session_string, "environment") if session_string else ("", "awaiting_admin_login")


def json_list(value: Any, fallback: list[str]) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
            if isinstance(decoded, list):
                return [str(item) for item in decoded]
        except json.JSONDecodeError:
            pass
    return fallback


def as_utc_datetime(value: datetime | None) -> datetime | None:
    """Return a timezone-aware UTC datetime for Telegram and PostgreSQL comparisons."""
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def media_details(message: Message, allowed: set[str]) -> dict[str, Any] | None:
    for media_type, attribute in MEDIA_ATTRIBUTES.items():
        if media_type not in allowed:
            continue
        item = getattr(message, attribute, None)
        if item is None:
            continue
        caption = message.caption or message.text or ""
        code_match = CODE_PATTERN.search(caption)
        part_match = PART_PATTERN.search(caption)
        part_number = int(part_match.group(1)) if part_match else None
        part_total = int(part_match.group(2)) if part_match and part_match.group(2) else None
        clean_title = re.sub(r"[^a-zA-Z0-9]+", " ", PART_PATTERN.sub("", caption)).strip().lower()
        part_group_key = (code_match.group(0).upper() if code_match else clean_title) if part_number else None
        return {
            "media_type": media_type,
            "caption": caption[:20000] or None,
            "code": code_match.group(0).upper() if code_match else None,
            "part_group_key": part_group_key[:180] if part_group_key else None,
            "part_number": part_number,
            "part_total": part_total,
            "file_unique_id": getattr(item, "file_unique_id", None),
            "mime_type": getattr(item, "mime_type", None),
            "file_size": getattr(item, "file_size", None),
            "media_group_id": message.media_group_id,
            "message_date": as_utc_datetime(message.date),
            "metadata": {
                "has_caption": bool(caption),
                "message_id": message.id,
                "chat_id": str(message.chat.id),
            },
        }
    return None


class HistoricalIndexer:
    def __init__(self) -> None:
        self.worker_id = os.environ.get(
            "INDEXER_WORKER_ID", f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}"
        )
        self.poll_interval = max(1, int(os.environ.get("POLL_INTERVAL_SECONDS", "5")))
        self.batch_size = max(1, int(os.environ.get("BATCH_SIZE", "50")))
        self.stop_event = asyncio.Event()
        self.pool: asyncpg.Pool | None = None
        self.client: Client | None = None
        self.auth_manager: TelegramAuthManager | None = None
        self.last_settings_refresh = 0.0
        self.last_auto_scan_check = 0.0

    async def start(self) -> None:
        database_url = required_env("DATABASE_URL")
        api_id = int(required_env("API_ID"))
        api_hash = required_env("API_HASH")
        self.pool = await asyncpg.create_pool(
            database_url,
            min_size=1,
            max_size=4,
            command_timeout=30,
            ssl="require" if os.environ.get("DATABASE_SSL", "require").strip().lower() not in {"false", "disable", "disabled"} else False,
        )
        self.auth_manager = TelegramAuthManager(api_id, api_hash, required_env("SESSION_ENCRYPTION_KEY"))
        encrypted = await self.pool.fetchval(
            "SELECT encrypted_value FROM public.private_runtime_secrets WHERE secret_name='pyrogram_session_string'"
        )
        session_string, session_source = resolve_session_string(os.environ, encrypted)
        LOG.info("Pyrogram session source selected | source=%s", session_source)
        if session_string:
            self.client = Client("piratecult-historical-indexer", api_id=api_id, api_hash=api_hash,
                                 session_string=session_string, no_updates=True)
            del session_string
            await self.client.start()
            me = await self.client.get_me()
            LOG.info("Pyrogram session connected | account_id=%s", me.id)
        else:
            LOG.info("No Telegram user session configured; waiting for admin login.")

    async def stop(self) -> None:
        self.stop_event.set()
        if self.client and self.client.is_connected:
            await self.client.stop()
        if self.auth_manager:
            await self.auth_manager.stop()
        if self.pool:
            await self.pool.close()

    async def indexing_enabled(self) -> bool:
        assert self.pool
        value = await self.pool.fetchval(
            "SELECT value FROM public.bot_settings WHERE key = 'historical_indexer_enabled'"
        )
        if isinstance(value, str):
            return value.strip().lower() == "true"
        return value is True

    async def claim_job(self) -> asyncpg.Record | None:
        assert self.pool
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                return await connection.fetchrow(
                    """
                    WITH candidate AS (
                      SELECT id
                      FROM public.historical_index_jobs
                      WHERE (status='queued' AND (next_retry_at IS NULL OR next_retry_at<=NOW()))
                         OR (status='running' AND lease_expires_at<NOW())
                      ORDER BY created_at ASC
                      FOR UPDATE SKIP LOCKED
                      LIMIT 1
                    )
                    UPDATE public.historical_index_jobs AS job
                    SET status = 'running',
                        attempt_count = attempt_count + 1,
                        next_retry_at = NULL,
                        lease_owner = $1,
                        lease_expires_at = NOW() + INTERVAL '3 minutes',
                        heartbeat_at = NOW(),
                        started_at = COALESCE(started_at, NOW()),
                        updated_at = NOW()
                    FROM candidate
                    WHERE job.id = candidate.id
                    RETURNING job.*
                    """,
                    self.worker_id,
                )

    async def update_progress(
        self,
        job: asyncpg.Record,
        last_message_id: int,
        scanned: int,
        indexed: int,
        duplicates: int,
        skipped: int,
        failed: int,
    ) -> str:
        assert self.pool
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                state = await connection.fetchrow(
                    """
                    UPDATE public.historical_index_jobs
                    SET last_processed_message_id = $2,
                        scanned_count = scanned_count + $3,
                        indexed_count = indexed_count + $4,
                        duplicate_count = duplicate_count + $5,
                        skipped_count = skipped_count + $6,
                        failed_count = failed_count + $7,
                        heartbeat_at = NOW(),
                        lease_expires_at = NOW() + INTERVAL '3 minutes',
                        updated_at = NOW()
                    WHERE id = $1 AND lease_owner = $8
                    RETURNING status, cancel_requested
                    """,
                    job["id"], last_message_id, scanned, indexed, duplicates,
                    skipped, failed, self.worker_id,
                )
                if not state:
                    return "lost"
                await connection.execute(
                    """
                    INSERT INTO public.historical_index_checkpoints
                      (job_id, source_id, last_message_id, updated_at)
                    VALUES ($1, $2, $3, NOW())
                    ON CONFLICT (job_id) DO UPDATE
                    SET last_message_id = EXCLUDED.last_message_id, updated_at = NOW()
                    """,
                    job["id"], job["source_id"], last_message_id,
                )
                await connection.execute(
                    "UPDATE public.index_sources SET last_scanned_message_id=$2, updated_at=NOW() WHERE id=$1",
                    job["source_id"], last_message_id,
                )
                if state["cancel_requested"]:
                    return "cancel"
                return str(state["status"])

    async def store_message(
        self, source_chat_id: str, message: Message, allowed: set[str]
    ) -> str:
        assert self.pool
        details = media_details(message, allowed)
        if details is None:
            return "skipped"
        async with self.pool.acquire() as connection:
            inserted = await connection.fetchval(
                """
                INSERT INTO public.media_source_refs (
                  source_chat_id, source_message_id, media_type, code, caption,
                  media_group_id, file_unique_id, mime_type, file_size,
                  message_date, metadata, part_group_key, part_number, part_total
                )
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14)
                ON CONFLICT (source_chat_id, source_message_id) DO NOTHING
                RETURNING id
                """,
                source_chat_id, message.id, details["media_type"],
                details["code"], details["caption"], details["media_group_id"],
                details["file_unique_id"], details["mime_type"], details["file_size"],
                details["message_date"], json.dumps(details["metadata"]),
                details["part_group_key"], details["part_number"], details["part_total"],
            )
            if inserted and details["part_group_key"]:
                await connection.execute(
                    """
                    INSERT INTO public.media_part_groups(source_chat_id,group_key,title,expected_parts,part_count,updated_at)
                    VALUES ($1,$2,$3,$4,1,NOW())
                    ON CONFLICT(source_chat_id,group_key) DO UPDATE SET
                      expected_parts=GREATEST(COALESCE(public.media_part_groups.expected_parts,0),COALESCE(EXCLUDED.expected_parts,0)),
                      part_count=(SELECT COUNT(*) FROM public.media_source_refs WHERE source_chat_id=$1 AND part_group_key=$2),
                      updated_at=NOW()
                    """,
                    source_chat_id, details["part_group_key"],
                    details["caption"][:180] if details["caption"] else None, details["part_total"],
                )
            return "indexed" if inserted else "duplicate"

    async def resolve_peer_from_dialogs(self, peer_id: int):
        assert self.client
        async for dialog in self.client.get_dialogs():
            chat = dialog.chat
            if chat and int(chat.id) == peer_id:
                return chat
        return None

    async def resolve_source_chat(self, source_chat_id: str):
        assert self.client
        raw_id = str(source_chat_id).strip()
        if not raw_id.lstrip("-").isdigit():
            return await self.client.get_chat(raw_id)
        target_id = int(raw_id)
        try:
            return await self.client.get_chat(target_id)
        except Exception as direct_error:
            LOG.info("Source peer not cached; searching account dialogs | source=%s", raw_id)
            chat = await self.resolve_peer_from_dialogs(target_id)
            if chat:
                return chat
            raise ValueError(
                f"Pyrogram account cannot access channel {raw_id}. "
                "Join it using the account in PYROGRAM_SESSION_STRING, then open it once."
            ) from direct_error

    async def process_job(self, job: asyncpg.Record) -> None:
        assert self.client and self.pool
        job_id = job["id"]
        source_chat_id = job["source_chat_id"]
        cursor = int(job["last_processed_message_id"] or 0)
        if cursor == 0 and job["end_message_id"]:
            cursor = int(job["end_message_id"]) + 1
        scanned = indexed = duplicates = skipped = failed = pending = 0
        last_message_id = cursor

        try:
            source_chat = await self.resolve_source_chat(source_chat_id)
            canonical_source_chat_id = str(source_chat.id)
            # Screenshot indexing is handled exclusively by the Telegraf bot
            # from screenshot-channel updates. The Pyrogram historical worker is
            # reserved for dump/video history and must never create screenshot refs.
            allowed = set(json_list(job["media_filters"], list(MEDIA_ATTRIBUTES)))
            allowed.discard("photo")
            if job["media_mode"] == "all":
                allowed = set(MEDIA_ATTRIBUTES) - {"photo"}
            LOG.info("Historical job started | job_id=%s | source=%s", job_id, source_chat_id)
            async for message in self.client.get_chat_history(
                source_chat.id, limit=0, offset_id=cursor
            ):
                if self.stop_event.is_set():
                    # Release immediately; the uncommitted batch will safely replay from its checkpoint.
                    await self.release_job(job_id)
                    return
                if job["start_message_id"] and message.id < job["start_message_id"]:
                    break
                if job["end_message_id"] and message.id > job["end_message_id"]:
                    continue

                message_date = as_utc_datetime(message.date)
                start_date = as_utc_datetime(job["start_date"])
                end_date = as_utc_datetime(job["end_date"])
                if message_date is not None and start_date and message_date < start_date:
                    break
                if message_date is not None and end_date and message_date > end_date:
                    last_message_id = message.id
                    scanned += 1
                    pending += 1
                    continue

                scanned += 1
                last_message_id = message.id
                try:
                    outcome = await self.store_message(canonical_source_chat_id, message, allowed)
                    if outcome == "indexed":
                        indexed += 1
                    elif outcome == "duplicate":
                        duplicates += 1
                    else:
                        skipped += 1
                except Exception:
                    failed += 1
                    LOG.exception("Message indexing failed | job_id=%s | message_id=%s", job_id, message.id)

                pending += 1
                if pending >= self.batch_size:
                    state = await self.update_progress(
                        job, last_message_id, scanned, indexed, duplicates, skipped, failed
                    )
                    scanned = indexed = duplicates = skipped = failed = pending = 0
                    if state == "cancel":
                        await self.finish_job(job_id, "cancelled")
                        return
                    if state == "paused":
                        await self.release_job(job_id)
                        return
                    if state != "running":
                        return

            if pending:
                state = await self.update_progress(
                    job, last_message_id, scanned, indexed, duplicates, skipped, failed
                )
                if state == "cancel":
                    await self.finish_job(job_id, "cancelled")
                    return
                if state == "paused":
                    await self.release_job(job_id)
                    return
                if state not in ("running",):
                    return

            await self.finish_job(job_id, "completed")
            LOG.info("Historical job completed | job_id=%s", job_id)
        except Exception as exc:
            LOG.exception("Historical job failed | job_id=%s", job_id)
            error_text = str(exc)[:2000]
            await self.fail_job(job_id, error_text)
            await self.notify_admins(
                f"❌ Historical indexing failed\\nJob: #{job_id}\\nSource: {source_chat_id}\\nError: {error_text[:1200]}"
            )

    async def notify_admins(self, message: str) -> None:
        if not self.client:
            return
        # Reuse the application's existing ADMIN_IDS by default.
        # HISTORICAL_INDEXER_NOTIFY_CHAT_IDS can optionally override the recipients.
        configured_ids = os.environ.get(
            "HISTORICAL_INDEXER_NOTIFY_CHAT_IDS",
            os.environ.get("ADMIN_IDS", ""),
        )
        chat_ids = [value.strip() for value in configured_ids.split(",") if value.strip()]
        if not chat_ids:
            LOG.warning("Historical failure notification skipped: HISTORICAL_INDEXER_NOTIFY_CHAT_IDS is empty")
            return
        for chat_id in chat_ids:
            try:
                target_id = int(chat_id)
                try:
                    target = await self.client.resolve_peer(target_id)
                except Exception:
                    target = await self.resolve_peer_from_dialogs(target_id)
                    if target is None:
                        raise ValueError(
                            "Admin is not present in the Pyrogram account's dialogs. "
                            "Open a private chat with the Pyrogram account first."
                        )
                await self.client.send_message(target, message, disable_web_page_preview=True)
            except Exception:
                LOG.exception(
                    "Could not notify admin | chat_id=%s. The Pyrogram account must have an existing private chat with this admin.",
                    chat_id,
                )

    async def release_job(self, job_id: int) -> None:
        assert self.pool
        await self.pool.execute(
            """
            UPDATE public.historical_index_jobs
            SET lease_owner = NULL, lease_expires_at = NULL, heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE id = $1 AND lease_owner = $2
            """,
            job_id, self.worker_id,
        )

    async def finish_job(self, job_id: int, status: str) -> None:
        assert self.pool
        await self.pool.execute(
            """
            UPDATE public.historical_index_jobs
            SET status = $2, lease_owner = NULL, lease_expires_at = NULL,
                finished_at = NOW(), updated_at = NOW()
            WHERE id = $1 AND lease_owner = $3
            """,
            job_id, status, self.worker_id,
        )
        if status == "completed":
            await self.pool.execute(
                "UPDATE public.index_sources SET last_scan_completed_at=NOW(),updated_at=NOW() WHERE id=(SELECT source_id FROM public.historical_index_jobs WHERE id=$1)",
                job_id,
            )

    async def fail_job(self, job_id: int, error: str) -> None:
        assert self.pool
        await self.pool.execute(
            """
            UPDATE public.historical_index_jobs
            SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
                error = $2, lease_owner = NULL, lease_expires_at = NULL,
                next_retry_at = CASE WHEN attempt_count < max_attempts
                  THEN NOW() + make_interval(secs => LEAST(300,15*power(2,GREATEST(attempt_count-1,0)))::integer)
                  ELSE NULL END,
                finished_at = CASE WHEN attempt_count < max_attempts THEN NULL ELSE NOW() END,
                updated_at = NOW()
            WHERE id = $1 AND lease_owner = $3
            """,
            job_id, error, self.worker_id,
        )

    async def refresh_runtime_settings(self) -> None:
        assert self.pool
        now = asyncio.get_running_loop().time()
        if now-self.last_settings_refresh < 30:
            return
        self.last_settings_refresh = now
        rows = await self.pool.fetch("SELECT key,value FROM public.bot_settings WHERE key IN ('historical_indexer_batch_size','historical_indexer_poll_interval')")
        for row in rows:
            try:
                value = int(str(row["value"]).strip('"'))
            except (TypeError, ValueError):
                continue
            if row["key"] == "historical_indexer_batch_size":
                self.batch_size = min(max(value,10),500)
            elif row["key"] == "historical_indexer_poll_interval":
                self.poll_interval = min(max(value,2),30)

    async def enqueue_due_sources(self) -> None:
        assert self.pool
        raw = await self.pool.fetchval("SELECT value FROM public.bot_settings WHERE key='historical_indexer_scan_interval_minutes'")
        try:
            interval = min(max(int(str(raw).strip('"')),15),10080) if raw is not None else 1440
        except (TypeError, ValueError):
            interval = 1440
        await self.pool.execute("""
          INSERT INTO public.historical_index_jobs(source_id,source_chat_id,status,media_mode,requested_by)
          SELECT s.id,s.source_chat_id,'queued',s.media_mode,s.created_by
          FROM public.index_sources s
          WHERE s.is_active
            AND (s.last_scan_completed_at IS NULL OR s.last_scan_completed_at<NOW()-make_interval(mins=>$1))
            AND NOT EXISTS (SELECT 1 FROM public.historical_index_jobs j
              WHERE j.source_id=s.id AND j.status IN ('queued','running','paused'))
            AND NOT EXISTS (SELECT 1 FROM public.historical_index_jobs f
              WHERE f.source_id=s.id AND f.status='failed' AND f.created_at>NOW()-INTERVAL '24 hours')
        """, interval)

    async def run(self) -> None:
        try:
            await self.start()
            LOG.info("Historical indexer worker ready | worker_id=%s", self.worker_id)
            while not self.stop_event.is_set():
                if self.auth_manager and self.pool and await self.auth_manager.process_one(self.pool,self):
                    continue
                if self.client and await self.indexing_enabled():
                    await self.refresh_runtime_settings()
                    now=asyncio.get_running_loop().time()
                    if now-self.last_auto_scan_check>=60:
                        self.last_auto_scan_check=now
                        await self.enqueue_due_sources()
                    job = await self.claim_job()
                    if job:
                        await self.process_job(job)
                        continue
                try:
                    await asyncio.wait_for(self.stop_event.wait(), timeout=self.poll_interval)
                except asyncio.TimeoutError:
                    pass
        finally:
            await self.stop()


async def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    worker = HistoricalIndexer()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, worker.stop_event.set)
        except NotImplementedError:
            pass
    await worker.run()


if __name__ == "__main__":
    asyncio.run(main())
