import { getSupabase } from '../database/supabase.ts';
import { getSetting, setSetting } from './settings.ts';

const CONTROL_KEY = 'historical_indexer_enabled';

export interface HistoricalIndexerStatus {
  enabled: boolean;
  queued: number;
  running: number;
  paused: number;
  completed: number;
  failed: number;
  total: number;
}

export async function getHistoricalIndexerStatus(): Promise<HistoricalIndexerStatus> {
  const supabase = getSupabase();
  const enabled = await getSetting<boolean>(CONTROL_KEY, false);
  const statuses = ['queued', 'running', 'paused', 'completed', 'failed'] as const;
  const counts = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await supabase
      .from('historical_index_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) throw new Error(`Failed counting historical ${status} jobs: ${error.message}`);
    return count ?? 0;
  }));
  const [queued, running, paused, completed, failed] = counts;
  return { enabled, queued, running, paused, completed, failed, total: counts.reduce((sum, value) => sum + value, 0) };
}

export async function startHistoricalIndexer(): Promise<void> {
  await setSetting(CONTROL_KEY, true);
}

export async function pauseHistoricalIndexer(): Promise<void> {
  const supabase = getSupabase();
  await setSetting(CONTROL_KEY, false);
  // The worker observes this status at its next checkpoint and releases its lease.
  const { error } = await supabase
    .from('historical_index_jobs')
    .update({ status: 'paused', updated_at: new Date().toISOString() })
    .eq('status', 'running');
  if (error) throw new Error(`Failed pausing historical jobs: ${error.message}`);
}

export async function resumeHistoricalIndexer(): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('historical_index_jobs')
    .update({
      status: 'queued',
      lease_owner: null,
      lease_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'paused');
  if (error) throw new Error(`Failed resuming historical jobs: ${error.message}`);
  await setSetting(CONTROL_KEY, true);
}
