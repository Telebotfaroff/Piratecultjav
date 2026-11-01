-- Live-schema compatibility migration. Safe for the current BIGINT-based database.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS daily_download_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS daily_download_date DATE NOT NULL DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS unlimited_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referred_by BIGINT,
  ADD COLUMN IF NOT EXISTS referral_reward_claimed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referral_completed BOOLEAN NOT NULL DEFAULT FALSE;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='users_plan_check') THEN
    ALTER TABLE users ADD CONSTRAINT users_plan_check CHECK (plan IN ('free','semi_premium','premium'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_plan_expires_at ON users(plan_expires_at);
CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by);
CREATE INDEX IF NOT EXISTS idx_users_referral_completed ON users(referral_completed);

ALTER TABLE force_sub_channels
  ADD COLUMN IF NOT EXISTS channel_id TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS invite_link TEXT,
  ADD COLUMN IF NOT EXISTS request_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- Older live schemas may have used is_enabled instead of is_active.
-- Do not reference that legacy column unless it actually exists.
DO $compat$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'force_sub_channels'
      AND column_name = 'is_enabled'
  ) THEN
    EXECUTE $sql$
      UPDATE force_sub_channels
      SET channel_id = COALESCE(channel_id, chat_id::TEXT),
          is_active = COALESCE(is_active, is_enabled, TRUE)
      WHERE channel_id IS NULL OR is_active IS NULL
    $sql$;
  ELSE
    UPDATE force_sub_channels
    SET channel_id = COALESCE(channel_id, chat_id::TEXT),
        is_active = COALESCE(is_active, TRUE)
    WHERE channel_id IS NULL OR is_active IS NULL;
  END IF;
END;
$compat$;

CREATE UNIQUE INDEX IF NOT EXISTS force_sub_channels_channel_id_key ON force_sub_channels(channel_id);

ALTER TABLE videos ADD COLUMN IF NOT EXISTS search_text TEXT;

CREATE OR REPLACE FUNCTION refresh_video_search_text() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_text := lower(concat_ws(' ',coalesce(NEW.code,''),coalesce(NEW.title,''),coalesce(NEW.description,''),coalesce(NEW.provider,''),coalesce(NEW.metadata::text,'')));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_refresh_video_search_text ON videos;
DROP TRIGGER IF EXISTS trg_videos_search_text ON videos;
CREATE TRIGGER trg_refresh_video_search_text
BEFORE INSERT OR UPDATE OF code,title,description,provider,metadata ON videos
FOR EACH ROW EXECUTE FUNCTION refresh_video_search_text();

UPDATE videos SET search_text=lower(concat_ws(' ',coalesce(code,''),coalesce(title,''),coalesce(description,''),coalesce(provider,''),coalesce(metadata::text,'')));

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_videos_search_text_trgm ON videos USING gin(search_text gin_trgm_ops);

CREATE OR REPLACE FUNCTION claim_next_index_job()
RETURNS SETOF index_jobs LANGUAGE plpgsql AS $$
DECLARE claimed_record index_jobs%ROWTYPE;
BEGIN
  SELECT * INTO claimed_record FROM index_jobs
  WHERE status='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=NOW())
  ORDER BY id ASC FOR UPDATE SKIP LOCKED LIMIT 1;
  IF FOUND THEN
    UPDATE index_jobs SET status='processing',next_attempt_at=NULL,attempts=attempts+1,updated_at=NOW()
    WHERE id=claimed_record.id RETURNING * INTO claimed_record;
    RETURN NEXT claimed_record;
  END IF;
  RETURN;
END $$;

CREATE OR REPLACE FUNCTION consume_video_download(p_user_id BIGINT)
RETURNS TABLE(allowed BOOLEAN,remaining INTEGER,plan TEXT,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; lim INTEGER; ep TEXT; unlim BOOLEAN;
BEGIN
 SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT FALSE,0,'free'::TEXT,NULL::TIMESTAMPTZ; RETURN; END IF;
 IF u.daily_download_date IS DISTINCT FROM CURRENT_DATE THEN
   UPDATE users SET daily_download_count=0,daily_download_date=CURRENT_DATE,updated_at=NOW()
   WHERE telegram_user_id=p_user_id RETURNING * INTO u;
 END IF;
 ep:=CASE WHEN u.plan_expires_at IS NOT NULL AND u.plan_expires_at<=NOW() THEN 'free' ELSE u.plan END;
 unlim:=ep='premium' OR (u.unlimited_until IS NOT NULL AND u.unlimited_until>NOW());
 IF unlim THEN RETURN QUERY SELECT TRUE,-1,ep,u.unlimited_until; RETURN; END IF;
 lim:=CASE WHEN ep='semi_premium' THEN 40 ELSE 20 END;
 IF u.daily_download_count>=lim THEN RETURN QUERY SELECT FALSE,0,ep,u.unlimited_until; RETURN; END IF;
 UPDATE users SET daily_download_count=daily_download_count+1,updated_at=NOW()
 WHERE telegram_user_id=p_user_id RETURNING * INTO u;
 RETURN QUERY SELECT TRUE,GREATEST(lim-u.daily_download_count,0),ep,u.unlimited_until;
END $$;

CREATE OR REPLACE FUNCTION get_user_access(p_user_id BIGINT)
RETURNS TABLE(plan TEXT,plan_expires_at TIMESTAMPTZ,unlimited_until TIMESTAMPTZ,daily_limit INTEGER,daily_used INTEGER,daily_remaining INTEGER,is_unlimited BOOLEAN)
LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; ep TEXT; lim INTEGER; unlim BOOLEAN;
BEGIN
 SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT 'free'::TEXT,NULL::TIMESTAMPTZ,NULL::TIMESTAMPTZ,20,0,20,FALSE; RETURN; END IF;
 ep:=CASE WHEN u.plan_expires_at IS NOT NULL AND u.plan_expires_at<=NOW() THEN 'free' ELSE u.plan END;
 lim:=CASE WHEN ep='semi_premium' THEN 40 ELSE 20 END;
 unlim:=ep='premium' OR (u.unlimited_until IS NOT NULL AND u.unlimited_until>NOW());
 RETURN QUERY SELECT ep,CASE WHEN u.plan_expires_at>NOW() THEN u.plan_expires_at ELSE NULL END,u.unlimited_until,CASE WHEN unlim THEN -1 ELSE lim END,u.daily_download_count,CASE WHEN unlim THEN -1 ELSE GREATEST(lim-u.daily_download_count,0) END,unlim;
END $$;

CREATE OR REPLACE FUNCTION set_user_plan(p_user_id BIGINT,p_plan TEXT,p_duration_days INTEGER DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
 IF p_plan NOT IN ('free','semi_premium','premium') THEN RETURN FALSE; END IF;
 UPDATE users SET plan=p_plan,plan_expires_at=CASE WHEN p_duration_days IS NULL THEN NULL WHEN p_duration_days<=0 THEN NOW() ELSE NOW()+make_interval(days=>p_duration_days) END,updated_at=NOW()
 WHERE telegram_user_id=p_user_id;
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION register_referral(p_referrer BIGINT,p_referred BIGINT)
RETURNS TABLE(success BOOLEAN,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE ru users%ROWTYPE; rr users%ROWTYPE;
BEGIN
 IF p_referrer IS NULL OR p_referred IS NULL OR p_referrer=p_referred THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO rr FROM users WHERE telegram_user_id=p_referrer FOR UPDATE;
 IF NOT FOUND OR rr.is_blocked THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO ru FROM users WHERE telegram_user_id=p_referred FOR UPDATE;
 IF NOT FOUND OR ru.referred_by IS NOT NULL OR ru.referral_completed THEN RETURN QUERY SELECT FALSE,ru.unlimited_until; RETURN; END IF;
 UPDATE users SET referred_by=p_referrer,updated_at=NOW() WHERE telegram_user_id=p_referred;
 RETURN QUERY SELECT TRUE,rr.unlimited_until;
END $$;

CREATE OR REPLACE FUNCTION complete_referral(p_referred BIGINT)
RETURNS TABLE(success BOOLEAN,unlimited_until TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE ru users%ROWTYPE; rr users%ROWTYPE; base_time TIMESTAMPTZ; nu TIMESTAMPTZ;
BEGIN
 SELECT * INTO ru FROM users WHERE telegram_user_id=p_referred FOR UPDATE;
 IF NOT FOUND OR ru.referred_by IS NULL OR ru.referral_completed THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO rr FROM users WHERE telegram_user_id=ru.referred_by FOR UPDATE;
 IF NOT FOUND OR rr.is_blocked THEN RETURN QUERY SELECT FALSE,NULL::TIMESTAMPTZ; RETURN; END IF;
 base_time:=GREATEST(COALESCE(rr.unlimited_until,NOW()),NOW()); nu:=base_time+INTERVAL '1 day';
 UPDATE users SET unlimited_until=nu,updated_at=NOW() WHERE telegram_user_id=rr.telegram_user_id;
 UPDATE users SET referral_completed=TRUE,referral_reward_claimed=TRUE,updated_at=NOW() WHERE telegram_user_id=ru.telegram_user_id;
 RETURN QUERY SELECT TRUE,nu;
END $$;

CREATE TABLE IF NOT EXISTS promo_codes(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),code TEXT NOT NULL UNIQUE,reward_type TEXT NOT NULL CHECK(reward_type IN('plan','unlimited')),
 reward_plan TEXT CHECK(reward_plan IN('semi_premium','premium')),reward_days INTEGER NOT NULL CHECK(reward_days>0),max_uses INTEGER,
 used_count INTEGER NOT NULL DEFAULT 0,expires_at TIMESTAMPTZ,is_active BOOLEAN NOT NULL DEFAULT TRUE,created_by BIGINT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CHECK((reward_type='plan' AND reward_plan IS NOT NULL) OR (reward_type='unlimited' AND reward_plan IS NULL)),CHECK(max_uses IS NULL OR max_uses>0)
);
CREATE TABLE IF NOT EXISTS promo_redemptions(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),promo_id UUID NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,
 redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(promo_id,telegram_user_id)
);
CREATE INDEX IF NOT EXISTS idx_promo_codes_active ON promo_codes(is_active,expires_at);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_user ON promo_redemptions(telegram_user_id);

CREATE OR REPLACE FUNCTION create_promo_code(p_code TEXT,p_reward_type TEXT,p_reward_plan TEXT,p_reward_days INTEGER,p_max_uses INTEGER DEFAULT NULL,p_expires_at TIMESTAMPTZ DEFAULT NULL,p_created_by BIGINT DEFAULT NULL)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE pid UUID;
BEGIN
 IF p_reward_type NOT IN('plan','unlimited') OR p_reward_days<=0 OR (p_reward_type='plan' AND p_reward_plan NOT IN('semi_premium','premium')) OR (p_reward_type='unlimited' AND p_reward_plan IS NOT NULL) THEN RETURN NULL; END IF;
 INSERT INTO promo_codes(code,reward_type,reward_plan,reward_days,max_uses,expires_at,created_by) VALUES(UPPER(TRIM(p_code)),p_reward_type,p_reward_plan,p_reward_days,p_max_uses,p_expires_at,p_created_by) RETURNING id INTO pid;
 RETURN pid;
EXCEPTION WHEN unique_violation THEN RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION redeem_promo_code(p_user_id BIGINT,p_code TEXT)
RETURNS TABLE(success BOOLEAN,message TEXT,reward_type TEXT,reward_plan TEXT,reward_days INTEGER,expires_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE p promo_codes%ROWTYPE; u users%ROWTYPE; ne TIMESTAMPTZ;
BEGIN
 SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR u.is_blocked THEN RETURN QUERY SELECT FALSE,'Account is not eligible.'::TEXT,NULL::TEXT,NULL::TEXT,0,NULL::TIMESTAMPTZ; RETURN; END IF;
 SELECT * INTO p FROM promo_codes WHERE code=UPPER(TRIM(p_code)) AND is_active FOR UPDATE;
 IF NOT FOUND THEN RETURN QUERY SELECT FALSE,'Invalid or inactive promo code.'::TEXT,NULL::TEXT,NULL::TEXT,0,NULL::TIMESTAMPTZ; RETURN; END IF;
 IF p.expires_at IS NOT NULL AND p.expires_at<=NOW() THEN RETURN QUERY SELECT FALSE,'This promo code has expired.'::TEXT,p.reward_type,p.reward_plan,p.reward_days,p.expires_at; RETURN; END IF;
 IF p.max_uses IS NOT NULL AND p.used_count>=p.max_uses THEN RETURN QUERY SELECT FALSE,'This promo code has reached its usage limit.'::TEXT,p.reward_type,p.reward_plan,p.reward_days,p.expires_at; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM promo_redemptions WHERE promo_id=p.id AND telegram_user_id=p_user_id) THEN RETURN QUERY SELECT FALSE,'You have already redeemed this promo code.'::TEXT,p.reward_type,p.reward_plan,p.reward_days,p.expires_at; RETURN; END IF;
 IF p.reward_type='plan' THEN
   ne:=GREATEST(COALESCE(u.plan_expires_at,NOW()),NOW())+make_interval(days=>p.reward_days);
   UPDATE users SET plan=p.reward_plan,plan_expires_at=ne,updated_at=NOW() WHERE telegram_user_id=p_user_id;
 ELSE
   ne:=GREATEST(COALESCE(u.unlimited_until,NOW()),NOW())+make_interval(days=>p.reward_days);
   UPDATE users SET unlimited_until=ne,updated_at=NOW() WHERE telegram_user_id=p_user_id;
 END IF;
 INSERT INTO promo_redemptions(promo_id,telegram_user_id) VALUES(p.id,p_user_id);
 UPDATE promo_codes SET used_count=used_count+1 WHERE id=p.id;
 RETURN QUERY SELECT TRUE,'Promo redeemed successfully.'::TEXT,p.reward_type,p.reward_plan,p.reward_days,ne;
END $$;

CREATE TABLE IF NOT EXISTS premium_payments(
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),telegram_user_id BIGINT NOT NULL REFERENCES users(telegram_user_id) ON DELETE CASCADE,payload TEXT NOT NULL,
 plan TEXT NOT NULL CHECK(plan='premium'),duration_days INTEGER NOT NULL CHECK(duration_days>0),amount_stars INTEGER NOT NULL CHECK(amount_stars>0),currency TEXT NOT NULL CHECK(currency='XTR'),
 telegram_payment_charge_id TEXT NOT NULL UNIQUE,provider_payment_charge_id TEXT,status TEXT NOT NULL DEFAULT 'completed',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_premium_payments_user ON premium_payments(telegram_user_id,created_at DESC);

CREATE OR REPLACE FUNCTION complete_star_premium_payment(p_user_id BIGINT,p_payload TEXT,p_duration_days INTEGER,p_amount_stars INTEGER,p_currency TEXT,p_telegram_charge_id TEXT,p_provider_charge_id TEXT)
RETURNS TABLE(success BOOLEAN,message TEXT,plan_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql AS $$
DECLARE u users%ROWTYPE; ne TIMESTAMPTZ;
BEGIN
 IF p_currency<>'XTR' OR p_duration_days<=0 OR p_amount_stars<=0 OR p_telegram_charge_id IS NULL OR p_telegram_charge_id='' THEN RETURN QUERY SELECT FALSE,'Invalid payment data.'::TEXT,NULL::TIMESTAMPTZ; RETURN; END IF;
 IF EXISTS(SELECT 1 FROM premium_payments WHERE telegram_payment_charge_id=p_telegram_charge_id) THEN SELECT plan_expires_at INTO ne FROM users WHERE telegram_user_id=p_user_id; RETURN QUERY SELECT TRUE,'Payment was already processed.'::TEXT,ne; RETURN; END IF;
 SELECT * INTO u FROM users WHERE telegram_user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR u.is_blocked THEN RETURN QUERY SELECT FALSE,'Account is not eligible.'::TEXT,NULL::TIMESTAMPTZ; RETURN; END IF;
 ne:=GREATEST(CASE WHEN u.plan='premium' AND u.plan_expires_at>NOW() THEN u.plan_expires_at ELSE NOW() END,NOW())+make_interval(days=>p_duration_days);
 UPDATE users SET plan='premium',plan_expires_at=ne,updated_at=NOW() WHERE telegram_user_id=p_user_id;
 INSERT INTO premium_payments(telegram_user_id,payload,plan,duration_days,amount_stars,currency,telegram_payment_charge_id,provider_payment_charge_id)
 VALUES(p_user_id,p_payload,'premium',p_duration_days,p_amount_stars,p_currency,p_telegram_charge_id,p_provider_charge_id);
 RETURN QUERY SELECT TRUE,'Premium activated successfully.'::TEXT,ne;
END $$;
