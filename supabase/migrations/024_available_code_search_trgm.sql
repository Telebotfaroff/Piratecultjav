-- Phase 6: accelerate partial normalized-code searches.
--
-- searchVideos() uses ILIKE '%term%' for normalized codes so users can find
-- partial code fragments. The existing B-tree normalized_code index cannot
-- accelerate leading-wildcard searches; pg_trgm can.
--
-- Migration 011 already enables pg_trgm. Keep this index partial because
-- user-facing search only returns available videos.

CREATE INDEX IF NOT EXISTS idx_videos_available_normalized_code_trgm
  ON public.videos USING gin (normalized_code gin_trgm_ops)
  WHERE status = 'available';
