-- PiratecultJAV security/performance indexes and constraints
-- Apply after the existing schema migrations.

CREATE INDEX IF NOT EXISTS idx_videos_provider_status_created
  ON videos (provider, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_videos_status_created
  ON videos (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_users_blocked_created
  ON users (is_blocked, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_index_jobs_status_next_attempt
  ON index_jobs (status, next_attempt_at, id);

CREATE INDEX IF NOT EXISTS idx_force_sub_active
  ON force_sub_channels (is_active, created_at ASC);

-- Normalize duplicate code variants at the database boundary.
CREATE UNIQUE INDEX IF NOT EXISTS uq_videos_normalized_code
  ON videos (normalized_code);


-- 2026-10 search improvements
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- concat_ws(text, VARIADIC "any") is not IMMUTABLE in PostgreSQL,
-- so it cannot be used in a STORED generated column. Keep search_text as a
-- regular column and maintain it with a trigger instead.
ALTER TABLE videos
  ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION public.refresh_video_search_text()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $
BEGIN
  NEW.search_text := lower(
    concat_ws(
      ' ',
      coalesce(NEW.code, ''),
      coalesce(NEW.title, ''),
      coalesce(NEW.description, ''),
      coalesce(NEW.provider, ''),
      coalesce(NEW.metadata::text, '')
    )
  );
  RETURN NEW;
END;
$;

DROP TRIGGER IF EXISTS trg_refresh_video_search_text ON videos;
CREATE TRIGGER trg_refresh_video_search_text
  BEFORE INSERT OR UPDATE OF code, title, description, provider, metadata
  ON videos
  FOR EACH ROW
  EXECUTE FUNCTION public.refresh_video_search_text();

-- Populate existing rows before creating the trigram index.
UPDATE videos
SET search_text = lower(
  concat_ws(
    ' ',
    coalesce(code, ''),
    coalesce(title, ''),
    coalesce(description, ''),
    coalesce(provider, ''),
    coalesce(metadata::text, '')
  )
)
WHERE search_text IS DISTINCT FROM lower(
  concat_ws(
    ' ',
    coalesce(code, ''),
    coalesce(title, ''),
    coalesce(description, ''),
    coalesce(provider, ''),
    coalesce(metadata::text, '')
  )
);

CREATE INDEX IF NOT EXISTS idx_videos_search_text_trgm
  ON videos USING gin (search_text gin_trgm_ops);
