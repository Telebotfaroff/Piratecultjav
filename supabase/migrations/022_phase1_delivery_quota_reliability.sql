-- Phase 1 reliability: atomic user tracking and idempotent quota reservations/refunds.

CREATE OR REPLACE FUNCTION track_telegram_user(
  p_telegram_user_id BIGINT,
  p_username TEXT DEFAULT NULL,
  p_first_name TEXT DEFAULT NULL,
  p_last_name TEXT DEFAULT NULL
)
RETURNS TABLE(is_new BOOLEAN, is_blocked BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  inserted BOOLEAN;
  blocked BOOLEAN;
BEGIN
  INSERT INTO users (telegram_user_id, username, first_name, last_name, updated_at)
  VALUES (p_telegram_user_id, p_username, p_first_name, p_last_name, NOW())
  ON CONFLICT (telegram_user_id) DO UPDATE
  SET username = EXCLUDED.username,
      first_name = EXCLUDED.first_name,
      last_name = EXCLUDED.last_name,
      updated_at = NOW()
  RETURNING (xmax = 0), users.is_blocked INTO inserted, blocked;

  RETURN QUERY SELECT COALESCE(inserted, FALSE), COALESCE(blocked, FALSE);
END;
$$;

CREATE TABLE IF NOT EXISTS video_download_reservations (
  reservation_id UUID PRIMARY KEY,
  telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'delivered', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quota_charged BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_video_download_reservations_user_created
  ON video_download_reservations (telegram_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION consume_video_download_with_reservation(
  p_user_id BIGINT,
  p_reservation_id UUID
)
RETURNS TABLE(allowed BOOLEAN, remaining INTEGER, plan TEXT, unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  existing video_download_reservations%ROWTYPE;
  result RECORD;
BEGIN
  SELECT * INTO existing FROM video_download_reservations
  WHERE reservation_id = p_reservation_id;

  IF FOUND THEN
    IF existing.telegram_user_id <> p_user_id OR existing.status = 'refunded' THEN
      RETURN QUERY SELECT FALSE, 0, 'free'::TEXT, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    SELECT u.plan, u.unlimited_until,
      CASE WHEN u.plan = 'premium' OR (u.unlimited_until IS NOT NULL AND u.unlimited_until > NOW()) THEN -1
      ELSE GREATEST(0, COALESCE((SELECT (value->>'free')::INTEGER FROM bot_settings WHERE key='download_quotas'),20) -
        CASE WHEN u.daily_download_date = CURRENT_DATE THEN u.daily_download_count ELSE 0 END) END AS remaining
    INTO result FROM users u WHERE u.telegram_user_id = p_user_id;
    RETURN QUERY SELECT TRUE, COALESCE(result.remaining, 0), COALESCE(result.plan, 'free'), result.unlimited_until;
    RETURN;
  END IF;

  SELECT * INTO result FROM consume_video_download(p_user_id);
  IF NOT COALESCE(result.allowed, FALSE) THEN
    RETURN QUERY SELECT FALSE, COALESCE(result.remaining, 0), COALESCE(result.plan, 'free'), result.unlimited_until;
    RETURN;
  END IF;

  INSERT INTO video_download_reservations(reservation_id, telegram_user_id, status, quota_charged)
  VALUES (
    p_reservation_id,
    p_user_id,
    'reserved',
    result.plan <> 'premium' AND NOT (result.unlimited_until IS NOT NULL AND result.unlimited_until > NOW())
  );

  RETURN QUERY SELECT TRUE, result.remaining, result.plan, result.unlimited_until;
END;
$$;

CREATE OR REPLACE FUNCTION mark_video_download_delivered(p_reservation_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE video_download_reservations
  SET status='delivered', updated_at=NOW()
  WHERE reservation_id=p_reservation_id AND status='reserved';
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed = 1;
END;
$$;

CREATE OR REPLACE FUNCTION refund_video_download(p_user_id BIGINT, p_reservation_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE changed INTEGER;
BEGIN
  UPDATE video_download_reservations
  SET status='refunded', updated_at=NOW()
  WHERE reservation_id=p_reservation_id
    AND telegram_user_id=p_user_id
    AND status='reserved';
  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed <> 1 THEN
    RETURN FALSE;
  END IF;

  UPDATE users
  SET daily_download_count=GREATEST(daily_download_count - 1, 0), updated_at=NOW()
  WHERE telegram_user_id=p_user_id
    AND daily_download_date=CURRENT_DATE
    AND EXISTS (
      SELECT 1 FROM video_download_reservations
      WHERE reservation_id=p_reservation_id AND quota_charged=TRUE
    );

  RETURN TRUE;
END;
$$;
