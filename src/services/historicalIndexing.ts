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


export interface HistoricalSource {
  id: string;
  source_chat_id: string;
  source_username: string | null;
  title: string | null;
  is_active: boolean;
}

export async function listHistoricalSources(limit = 10): Promise<HistoricalSource[]> {
  const { data, error } = await getSupabase()
    .from('index_sources')
    .select('id, source_chat_id, source_username, title, is_active')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 25));
  if (error) throw new Error(`Failed loading historical sources: ${error.message}`);
  return (data || []) as HistoricalSource[];
}

export async function enqueueHistoricalSource(input: string, requestedBy: number): Promise<{ source: HistoricalSource; jobId: number; alreadyQueued: boolean }> {
  const supabase = getSupabase();
  const raw = input.trim();
  let candidate = raw.trim();
  candidate = candidate.replace(/^https?:/i, '');
  if (candidate.startsWith('//')) candidate = candidate.slice(2);
  if (candidate.toLowerCase().startsWith('www.t.me/')) candidate = candidate.slice(9);
  else if (candidate.toLowerCase().startsWith('t.me/')) candidate = candidate.slice(5);
  const username = candidate.replace(/^@/, '').split('/')[0];
  const isUsername = /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(username) && !/^-?\d+$/.test(username);
  const sourceChatId = isUsername ? username : raw;
  if (!isUsername && !/^-100\d{5,}$/.test(sourceChatId)) {
    throw new Error('Send a public @username / t.me link or a numeric channel ID like -1001234567890.');
  }

  const { data: existingSource, error: lookupError } = await supabase
    .from('index_sources')
    .select('id, source_chat_id, source_username, title, is_active')
    .eq('source_chat_id', sourceChatId)
    .maybeSingle();
  if (lookupError) throw new Error(`Failed checking source: ${lookupError.message}`);

  let source = existingSource as HistoricalSource | null;
  if (!source) {
    const { data, error } = await supabase
      .from('index_sources')
      .insert({
        source_chat_id: sourceChatId,
        source_username: isUsername ? username : null,
        title: isUsername ? `@${username}` : sourceChatId,
        is_active: true,
        media_mode: 'all',
        created_by: requestedBy,
      })
      .select('id, source_chat_id, source_username, title, is_active')
      .single();
    if (error) throw new Error(`Failed adding source channel: ${error.message}`);
    source = data as HistoricalSource;
  } else if (!source.is_active) {
    const { error } = await supabase.from('index_sources').update({ is_active: true }).eq('id', source.id);
    if (error) throw new Error(`Failed activating source: ${error.message}`);
    source.is_active = true;
  }

  const { data: activeJob, error: activeError } = await supabase
    .from('historical_index_jobs')
    .select('id')
    .eq('source_id', source.id)
    .in('status', ['queued', 'running', 'paused'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) throw new Error(`Failed checking existing source jobs: ${activeError.message}`);
  if (activeJob) return { source, jobId: Number(activeJob.id), alreadyQueued: true };

  const { data: job, error: jobError } = await supabase
    .from('historical_index_jobs')
    .insert({
      source_id: source.id,
      source_chat_id: sourceChatId,
      status: 'queued',
      media_mode: 'all',
      start_message_id: null,
      end_message_id: null,
      requested_by: requestedBy,
    })
    .select('id')
    .single();
  if (jobError) throw new Error(`Failed creating historical indexing job: ${jobError.message}`);
  return { source, jobId: Number(job.id), alreadyQueued: false };
}
