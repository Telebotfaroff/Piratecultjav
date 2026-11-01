-- Phase 7: aggregate delivery analytics in PostgreSQL.
-- Avoid transferring every event row to the bot process for /analytics.

CREATE OR REPLACE FUNCTION public.get_video_delivery_analytics(p_since TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'attempts', count(*) FILTER (WHERE event_type = 'attempt'),
    'delivered', count(*) FILTER (WHERE event_type = 'delivered'),
    'forceSubBlocks', count(*) FILTER (WHERE event_type = 'force_sub_block'),
    'limitBlocks', count(*) FILTER (WHERE event_type = 'limit_block'),
    'failures', count(*) FILTER (WHERE event_type = 'delivery_failed'),
    'uniqueUsers', count(DISTINCT telegram_user_id),
    'topVideos', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('code', ranked.code, 'deliveries', ranked.deliveries)
                       ORDER BY ranked.deliveries DESC, ranked.code ASC)
      FROM (
        SELECT code, count(*) AS deliveries
          FROM public.video_delivery_events
         WHERE created_at >= p_since
           AND event_type = 'delivered'
           AND code IS NOT NULL
         GROUP BY code
         ORDER BY count(*) DESC, code ASC
         LIMIT 10
      ) AS ranked
    ), '[]'::jsonb)
  )
  FROM public.video_delivery_events
  WHERE created_at >= p_since;
$$;

REVOKE ALL ON FUNCTION public.get_video_delivery_analytics(TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_video_delivery_analytics(TIMESTAMPTZ) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_video_delivery_analytics(TIMESTAMPTZ) TO service_role;
