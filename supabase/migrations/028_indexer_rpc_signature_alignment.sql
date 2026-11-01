-- Phase 11: align the indexer RPC signature with PostgREST's argument lookup.
-- The RPC uses named parameters; keep their declaration and client payload order identical.

DROP FUNCTION IF EXISTS public.claim_next_index_job(TEXT, INTEGER);
DROP FUNCTION IF EXISTS public.claim_next_index_job(INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.claim_next_index_job();

CREATE OR REPLACE FUNCTION public.claim_next_index_job(
  p_lease_seconds INTEGER,
  p_worker_id TEXT
)
RETURNS SETOF public.index_jobs
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  claimed_record public.index_jobs%ROWTYPE;
  lease_duration INTEGER := GREATEST(60, LEAST(COALESCE(p_lease_seconds, 180), 1800));
BEGIN
  IF p_worker_id IS NULL OR length(trim(p_worker_id)) = 0 THEN
    RAISE EXCEPTION 'p_worker_id must not be empty';
  END IF;

  SELECT *
    INTO claimed_record
    FROM public.index_jobs
   WHERE status = 'queued'
     AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
   ORDER BY id ASC
   FOR UPDATE SKIP LOCKED
   LIMIT 1;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  UPDATE public.index_jobs
     SET status = 'processing',
         attempts = COALESCE(attempts, 0) + 1,
         worker_id = p_worker_id,
         lease_expires_at = NOW() + make_interval(secs => lease_duration),
         next_attempt_at = NULL,
         updated_at = NOW()
   WHERE id = claimed_record.id
   RETURNING * INTO claimed_record;

  RETURN NEXT claimed_record;
END;
$$;

-- Retain the no-argument compatibility RPC for older deployed callers.
CREATE OR REPLACE FUNCTION public.claim_next_index_job()
RETURNS SETOF public.index_jobs
LANGUAGE sql
SET search_path = public
AS $$
  SELECT *
    FROM public.claim_next_index_job(
      900,
      'legacy:' || gen_random_uuid()::TEXT
    );
$$;

GRANT EXECUTE ON FUNCTION public.claim_next_index_job(INTEGER, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_next_index_job() TO service_role;

NOTIFY pgrst, 'reload schema';
