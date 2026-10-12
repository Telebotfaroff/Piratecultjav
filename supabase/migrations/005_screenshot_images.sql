-- Screenshot images collected from the configured private Telegram channel.
CREATE TABLE IF NOT EXISTS screenshot_images (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code TEXT NOT NULL,
  normalized_code TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id BIGINT NOT NULL,
  file_id TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_screenshot_channel_message UNIQUE (channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_screenshot_images_code_created
  ON screenshot_images (normalized_code, created_at ASC);

ALTER TABLE screenshot_images ENABLE ROW LEVEL SECURITY;
-- Access is server-side only through the Supabase secret key. No public policies.
