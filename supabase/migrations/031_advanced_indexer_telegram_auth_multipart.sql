-- Advanced historical indexing, Telegram account login and multipart detection.
ALTER TABLE public.historical_index_jobs
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
ALTER TABLE public.index_sources ADD COLUMN IF NOT EXISTS last_scan_completed_at TIMESTAMPTZ;
ALTER TABLE public.media_source_refs
  ADD COLUMN IF NOT EXISTS part_group_key TEXT,
  ADD COLUMN IF NOT EXISTS part_number INTEGER,
  ADD COLUMN IF NOT EXISTS part_total INTEGER;
CREATE INDEX IF NOT EXISTS idx_media_source_refs_part_group
  ON public.media_source_refs (source_chat_id, part_group_key, part_number)
  WHERE part_group_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.media_part_groups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_chat_id TEXT NOT NULL,
  group_key TEXT NOT NULL,
  title TEXT,
  expected_parts INTEGER,
  part_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_chat_id, group_key)
);
CREATE INDEX IF NOT EXISTS idx_media_part_groups_updated ON public.media_part_groups (updated_at DESC);
CREATE TABLE IF NOT EXISTS public.telegram_auth_requests (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_telegram_id BIGINT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('start','code','password','cancel','disconnect')),
  encrypted_payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','processing','waiting_code','waiting_password','completed','failed','cancelled')),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_telegram_auth_requests_queue
  ON public.telegram_auth_requests (status, created_at ASC) WHERE status='queued';
CREATE INDEX IF NOT EXISTS idx_telegram_auth_requests_admin
  ON public.telegram_auth_requests (admin_telegram_id, created_at DESC);
CREATE TABLE IF NOT EXISTS public.telegram_user_sessions (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id=1),
  telegram_user_id BIGINT NOT NULL,
  username TEXT,
  first_name TEXT,
  phone_last4 TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.telegram_auth_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.telegram_user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_part_groups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.telegram_auth_requests, public.telegram_user_sessions, public.media_part_groups FROM anon, authenticated;
GRANT ALL PRIVILEGES ON public.telegram_auth_requests, public.telegram_user_sessions, public.media_part_groups TO service_role;
