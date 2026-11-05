-- Backfill provider-not-found jobs that were not recorded by the indexer.
-- index_jobs.code is normalized when jobs are created, so upper(trim(code))
-- matches the normalized_code convention used by missed_metadata_codes.
INSERT INTO missed_metadata_codes (code, normalized_code, failure_reason, created_at, updated_at)
SELECT DISTINCT ON (upper(btrim(code)))
  upper(btrim(code)) AS code,
  upper(btrim(code)) AS normalized_code,
  left(error, 1000) AS failure_reason,
  COALESCE(updated_at, NOW()) AS created_at,
  NOW() AS updated_at
FROM index_jobs
WHERE status = 'failed'
  AND error ILIKE 'Not found on Javtiful:%'
  AND code IS NOT NULL
  AND btrim(code) <> ''
ORDER BY upper(btrim(code)), updated_at DESC NULLS LAST
ON CONFLICT (normalized_code) DO UPDATE
SET failure_reason = EXCLUDED.failure_reason,
    updated_at = NOW();
