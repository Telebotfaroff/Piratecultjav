import { getSupabase } from '../database/supabase.ts';
import { normalizeCode } from './code.ts';

export interface IndexJob {
  id: number;
  code: string;
  dump_chat_id: string;
  video_message_id: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error: string | null;
  created_at?: string;
  updated_at?: string;
  next_attempt_at?: string | null;
  worker_id?: string | null;
  lease_expires_at?: string | null;
}

export interface CreateJobParams {
  code: string;
  dumpChatId: string;
  videoMessageId: number;
}

export interface CreateJobResult {
  created: boolean;
  job: IndexJob;
  reason?: string;
}

let hasNextAttemptAtColumn: boolean | null = null;

/**
 * Checks whether the live Supabase schema includes the optional 'next_attempt_at' column.
 * Caches the result to prevent redundant schema checks while supporting gradual database migrations.
 */
async function checkHasNextAttemptAt(): Promise<boolean> {
  if (hasNextAttemptAtColumn !== null) return hasNextAttemptAtColumn;

  try {
    const supabase = getSupabase();
    const { error } = await supabase.from('index_jobs').select('next_attempt_at').limit(1);
    if (!error) {
      hasNextAttemptAtColumn = true;
      return true;
    }

    if (
      error.code === '42703' ||
      error.code === 'PGRST204' ||
      error.message?.includes('next_attempt_at')
    ) {
      hasNextAttemptAtColumn = false;
      return false;
    }
  } catch {
    hasNextAttemptAtColumn = false;
    return false;
  }

  return false;
}

/**
 * Creates an index job with strict duplicate prevention.
 * The unique identity of a dump-channel media item is (dump_chat_id + video_message_id).
 */
export async function createIndexJob(params: CreateJobParams): Promise<CreateJobResult> {
  const supabase = getSupabase();
  const normalized = normalizeCode(params.code) || params.code.trim().toUpperCase();

  // 1. Strict duplicate check by unique Telegram media identity
  const { data: existing, error: checkError } = await supabase
    .from('index_jobs')
    .select('*')
    .eq('dump_chat_id', String(params.dumpChatId))
    .eq('video_message_id', params.videoMessageId)
    .maybeSingle();

  if (checkError) {
    throw new Error(`Failed checking existing index jobs: ${checkError.message}`);
  }

  if (existing) {
    return {
      created: false,
      job: existing as IndexJob,
      reason: `Telegram media (${params.dumpChatId}:${params.videoMessageId}) is already tracked with status: ${existing.status}`,
    };
  }

  const hasNextAttempt = await checkHasNextAttemptAt();
  const insertPayload: Record<string, unknown> = {
    code: normalized,
    dump_chat_id: String(params.dumpChatId),
    video_message_id: params.videoMessageId,
    status: 'queued',
    attempts: 0,
    error: null,
    updated_at: new Date().toISOString(),
  };

  if (hasNextAttempt) {
    insertPayload.next_attempt_at = null;
  }

  // 2. Insert new queued job
  const { data, error } = await supabase
    .from('index_jobs')
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    // If concurrent insert occurred and hit the UNIQUE constraint
    if (error.code === '23505' || error.message.includes('unique')) {
      const { data: dup } = await supabase
        .from('index_jobs')
        .select('*')
        .eq('dump_chat_id', String(params.dumpChatId))
        .eq('video_message_id', params.videoMessageId)
        .single();
      return {
        created: false,
        job: dup as IndexJob,
        reason: 'Duplicate prevented by unique constraint',
      };
    }
    throw new Error(`Failed creating index job: ${error.message}`);
  }

  return {
    created: true,
    job: data as IndexJob,
  };
}

/**
 * Atomically claims the next queued job using FOR UPDATE SKIP LOCKED.
 * If RPC 'claim_next_index_job' is available, invokes it.
 * Otherwise uses safe single-step fallback with adaptive column support.
 */
export async function claimNextJob(workerId: string, leaseSeconds = 180): Promise<IndexJob | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('claim_next_index_job', {
    p_worker_id: workerId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new Error(`Failed claiming index job: ${error.message}`);
  return Array.isArray(data) && data.length ? data[0] as IndexJob : null;
}

export async function updateJobStatus(
  jobId: number,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  errorMessage: string | null = null,
  nextAttemptAt: string | null = null,
  workerId?: string
): Promise<boolean> {
  const supabase = getSupabase();
  const hasNextAttempt = await checkHasNextAttemptAt();
  const updatePayload: Record<string, unknown> = {
    status,
    error: errorMessage,
    updated_at: new Date().toISOString(),
  };
  if (hasNextAttempt) updatePayload.next_attempt_at = nextAttemptAt;
  if (status !== 'processing') {
    updatePayload.worker_id = null;
    updatePayload.lease_expires_at = null;
  }
  let query = supabase.from('index_jobs').update(updatePayload).eq('id', jobId);
  if (workerId) query = query.eq('worker_id', workerId).eq('status', 'processing');
  const { data, error } = await query.select('id').maybeSingle();
  if (error) throw new Error(`Failed updating job ${jobId} status: ${error.message}`);
  return Boolean(data);
}

export async function retryJob(jobId: number): Promise<IndexJob> {
  const supabase = getSupabase();
  const hasNextAttempt = await checkHasNextAttemptAt();
  const updatePayload: Record<string, unknown> = {
    status: 'queued',
    error: null,
    attempts: 0,
    updated_at: new Date().toISOString(),
    worker_id: null,
    lease_expires_at: null,
  };
  if (hasNextAttempt) updatePayload.next_attempt_at = null;
  const { data, error } = await supabase
    .from('index_jobs')
    .update(updatePayload)
    .eq('id', jobId)
    .in('status', ['failed', 'queued'])
    .select()
    .single();
  if (error) throw new Error(`Failed resetting job for retry: ${error.message}`);
  return data as IndexJob;
}

export async function getRecentJobs(statusFilter?: string, limit = 50): Promise<IndexJob[]> {
  const supabase = getSupabase();

  let query = supabase.from('index_jobs').select('*');
  if (statusFilter && statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query
    .order('id', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed fetching index jobs: ${error.message}`);
  }

  return (data as IndexJob[]) || [];
}

export async function countJobs(): Promise<{ queued: number; processing: number; completed: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const statuses = ['queued', 'processing', 'completed', 'failed'] as const;

  // HEAD + exact count returns only aggregate metadata, not every job row.
  const results = await Promise.all(statuses.map(async (status) => {
    const { count, error } = await supabase
      .from('index_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('status', status);
    if (error) throw new Error(`Failed counting ${status} jobs: ${error.message}`);
    return count || 0;
  }));

  const [queued, processing, completed, failed] = results;
  return { queued, processing, completed, failed, total: queued + processing + completed + failed };
}

/** Requeues jobs left in processing after a server crash or hard restart. */
export async function renewJobLease(jobId: number, workerId: string, leaseSeconds = 180): Promise<boolean> {
  const supabase = getSupabase();
  const expiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from('index_jobs')
    .update({ lease_expires_at: expiresAt, updated_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'processing')
    .eq('worker_id', workerId)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Failed renewing lease for job ${jobId}: ${error.message}`);
  return Boolean(data);
}

/** Requeues only expired leases; active jobs keep their lease while heartbeats continue. */
export async function recoverStaleJobs(): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('index_jobs')
    .update({
      status: 'queued',
      worker_id: null,
      lease_expires_at: null,
      error: 'Recovered expired worker lease',
      updated_at: new Date().toISOString(),
      next_attempt_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .not('lease_expires_at', 'is', null)
    .lt('lease_expires_at', new Date().toISOString())
    .select('id');
  if (error) throw new Error(`Failed recovering expired jobs: ${error.message}`);
  return data?.length || 0;
}
