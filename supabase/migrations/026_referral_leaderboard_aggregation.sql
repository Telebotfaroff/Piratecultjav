-- Phase 7: compute the referral leaderboard in PostgreSQL.
-- The previous implementation downloaded the complete users table and grouped
-- referrals in the application process.

CREATE OR REPLACE FUNCTION public.get_referral_leaderboard(p_limit INTEGER DEFAULT 10)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'telegram_user_id', ranked.telegram_user_id,
      'display_name', ranked.display_name,
      'completed_referrals', ranked.completed_referrals,
      'total_referrals', ranked.total_referrals
    )
    ORDER BY ranked.completed_referrals DESC,
             ranked.total_referrals DESC,
             ranked.telegram_user_id ASC
  ), '[]'::jsonb)
  FROM (
    SELECT
      referrer.telegram_user_id,
      left(COALESCE(NULLIF(referrer.first_name, ''),
                    NULLIF(referrer.username, ''),
                    'User ' || referrer.telegram_user_id::TEXT), 40) AS display_name,
      count(*) FILTER (WHERE referred.referral_completed IS TRUE)::INTEGER AS completed_referrals,
      count(*)::INTEGER AS total_referrals
    FROM public.users AS referred
    JOIN public.users AS referrer
      ON referrer.telegram_user_id = referred.referred_by
    WHERE referrer.is_blocked IS NOT TRUE
    GROUP BY referrer.telegram_user_id, referrer.first_name, referrer.username
    ORDER BY completed_referrals DESC, total_referrals DESC, referrer.telegram_user_id ASC
    LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 10), 25))
  ) AS ranked;
$$;

REVOKE ALL ON FUNCTION public.get_referral_leaderboard(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_referral_leaderboard(INTEGER) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_referral_leaderboard(INTEGER) TO service_role;
