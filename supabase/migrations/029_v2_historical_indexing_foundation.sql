-- PiratecultJAV V2: additive foundation for historical Telegram indexing.
-- Existing catalog and delivery tables are intentionally preserved.

CREATE TABLE IF NOT EXISTS public.index_sources (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_chat_id TEXT NOT NULL UNIQUE,
  source_username TEXT,
  title TEXT,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  media_mode TEXT NOT NULL DEFAULT 'all' CHECK (media_mode IN ('all', 'selective')),
  media_filters JSONB NOT NULL DEFAULT '["photo","video","document","animation","audio","voice","video_note"]'::jsonb,
  last_scanned_message_id BIGINT NOT NULL DEFAULT 0,
  created_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_index_sources_active
  ON public.index_sources (is_active, updated_at DESC);

CREATE TABLE IF NOT EXISTS public.historical_index_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_id UUID NOT NULL REFERENCES public.index_sources(id) ON DELETE RESTRICT,
  source_chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'failed', 'cancelled')),
  media_mode TEXT NOT NULL DEFAULT 'all'
    CHECK (media_mode IN ('all', 'selective')),
  media_filters JSONB NOT NULL DEFAULT '["photo","video","document","animation","audio","voice","video_note"]'::jsonb,
  start_message_id BIGINT,
  end_message_id BIGINT,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  last_processed_message_id BIGINT NOT NULL DEFAULT 0,
  scanned_count BIGINT NOT NULL DEFAULT 0,
  indexed_count BIGINT NOT NULL DEFAULT 0,
  duplicate_count BIGINT NOT NULL DEFAULT 0,
  skipped_count BIGINT NOT NULL DEFAULT 0,
  failed_count BIGINT NOT NULL DEFAULT 0,
  cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  requested_by BIGINT,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT historical_index_job_range_check
    CHECK (start_message_id IS NULL OR end_message_id IS NULL OR start_message_id <= end_message_id),
  CONSTRAINT historical_index_job_date_check
    CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

CREATE INDEX IF NOT EXISTS idx_historical_index_jobs_queue
  ON public.historical_index_jobs (status, created_at ASC)
  WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS idx_historical_index_jobs_source
  ON public.historical_index_jobs (source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.historical_index_checkpoints (
  job_id BIGINT PRIMARY KEY REFERENCES public.historical_index_jobs(id) ON DELETE CASCADE,
  source_id UUID NOT NULL REFERENCES public.index_sources(id) ON DELETE RESTRICT,
  last_message_id BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.media_source_refs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_chat_id TEXT NOT NULL,
  source_message_id BIGINT NOT NULL,
  media_type TEXT NOT NULL
    CHECK (media_type IN ('photo', 'video', 'document', 'animation', 'audio', 'voice', 'video_note', 'sticker', 'other')),
  code TEXT,
  caption TEXT,
  media_group_id TEXT,
  file_unique_id TEXT,
  mime_type TEXT,
  file_size BIGINT,
  message_date TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_media_source_message UNIQUE (source_chat_id, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_media_source_refs_code
  ON public.media_source_refs (lower(code))
  WHERE code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_media_source_refs_type_date
  ON public.media_source_refs (media_type, message_date DESC);

CREATE INDEX IF NOT EXISTS idx_media_source_refs_file_unique
  ON public.media_source_refs (file_unique_id)
  WHERE file_unique_id IS NOT NULL;

-- Telegram file_id values are scoped to the bot that obtained them.
-- Keep them in this table with an explicit bot identity instead of treating
-- them as globally reusable media identifiers.
CREATE TABLE IF NOT EXISTS public.media_bot_refs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  media_source_ref_id UUID NOT NULL REFERENCES public.media_source_refs(id) ON DELETE CASCADE,
  bot_id BIGINT NOT NULL,
  bot_username TEXT,
  bot_role TEXT NOT NULL CHECK (bot_role IN ('controller', 'user', 'legacy', 'other')),
  file_id TEXT NOT NULL,
  file_unique_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_media_bot_ref UNIQUE (media_source_ref_id, bot_id)
);

CREATE INDEX IF NOT EXISTS idx_media_bot_refs_bot
  ON public.media_bot_refs (bot_id, updated_at DESC);

-- The active User Bot identity is metadata only. Its token is stored separately
-- as encrypted secret material and must never be stored in this table.
CREATE TABLE IF NOT EXISTS public.telegram_bot_runtime (
  role TEXT PRIMARY KEY CHECK (role IN ('controller', 'user')),
  bot_id BIGINT,
  username TEXT,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  last_verified_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Encrypted values only. Encryption/decryption is performed by the application
-- using a key supplied outside the database (for example RUNTIME_SECRET_KEY).
CREATE TABLE IF NOT EXISTS public.private_runtime_secrets (
  secret_name TEXT PRIMARY KEY,
  encrypted_value TEXT NOT NULL,
  encryption_version SMALLINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.private_runtime_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.private_runtime_secrets FROM anon, authenticated;
GRANT ALL PRIVILEGES ON public.private_runtime_secrets TO service_role;

-- Record which bot originally obtained legacy screenshot and thumbnail IDs.
-- Existing rows remain NULL and must be treated as unknown until verified.
ALTER TABLE public.screenshot_images
  ADD COLUMN IF NOT EXISTS source_bot_id BIGINT,
  ADD COLUMN IF NOT EXISTS source_bot_username TEXT;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS thumbnail_bot_id BIGINT,
  ADD COLUMN IF NOT EXISTS thumbnail_bot_username TEXT;

-- Keep the new operational tables private to the backend service role.
ALTER TABLE public.index_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_index_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.historical_index_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_source_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_bot_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_bot_runtime ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.index_sources, public.historical_index_jobs,
  public.historical_index_checkpoints, public.media_source_refs,
  public.media_bot_refs, public.telegram_bot_runtime
  FROM anon, authenticated;

GRANT ALL PRIVILEGES ON public.index_sources, public.historical_index_jobs,
  public.historical_index_checkpoints, public.media_source_refs,
  public.media_bot_refs, public.telegram_bot_runtime
  TO service_role;

GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.historical_index_jobs_id_seq TO service_role;
