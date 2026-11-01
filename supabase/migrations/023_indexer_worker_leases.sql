-- Phase 3: lease-based indexer ownership and concurrent claiming.
-- Apply this migration before deploying the Phase 3 application code.

ALTER TABLE public.index_jobs
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_index_jobs_expired_leases
  ON public.index_jobs (lease_expires_at)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_index_jobs_ready_queue
  ON public.index_jobs (next_attempt_at, id)
  WHERE status = 'queued';

-- Each worker slot claims one job in a single transaction. SKIP LOCKED prevents
-- multiple application instances from claiming the same row.
CREATE OR REPLACE FUNCTION public.claim_next_index_job(
  p_worker_id TEXT,
  p_lease_seconds INTEGER DEFAULT 180
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

-- Backfill jobs that were already processing when this migration is deployed.
UPDATE public.index_jobs
   SET worker_id = COALESCE(worker_id, 'legacy-worker'),
       lease_expires_at = COALESCE(lease_expires_at, COALESCE(updated_at, NOW()) + INTERVAL '15 minutes')
 WHERE status = 'processing'
   AND lease_expires_at IS NULL;

-- Preserve compatibility with older application instances during rolling deploys.
-- The old client calls the no-argument RPC; give those jobs a longer lease.
CREATE OR REPLACE FUNCTION public.claim_next_index_job()
RETURNS SETOF public.index_jobs
LANGUAGE plpgsql
SET search_path = public
AS $
BEGIN
  RETURN QUERY
  SELECT *
    FROM public.claim_next_index_job('legacy:' || gen_random_uuid()::TEXT, 900);
END;
$;
