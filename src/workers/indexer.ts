import { randomUUID } from 'node:crypto';
import {
  claimNextJob,
  updateJobStatus,
  recoverStaleJobs,
  renewJobLease,
  IndexJob,
} from '../services/indexJobs.ts';
import { javtifulProvider, ProviderNotFoundError, ProviderTemporaryError } from '../providers/javtiful/index.ts';
import { upsertVideoFromProvider } from '../services/videos.ts';
import { logEvent } from '../services/observability.ts';

const clampInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

export class IndexerWorker {
  private isRunning = false;
  private readonly pollIntervalMs = clampInt(process.env.INDEXER_POLL_INTERVAL_MS, 4000, 500, 60000);
  private readonly delayBetweenRequestsMs = clampInt(process.env.INDEXER_PROVIDER_DELAY_MS, 2000, 0, 60000);
  private readonly concurrency = clampInt(process.env.INDEXER_CONCURRENCY, 2, 1, 10);
  private readonly maxAttempts = clampInt(process.env.INDEXER_MAX_ATTEMPTS, 3, 1, 10);
  private readonly leaseSeconds = clampInt(process.env.INDEXER_LEASE_SECONDS, 180, 60, 1800);
  private readonly heartbeatMs = Math.min(30000, Math.max(10000, Math.floor(this.leaseSeconds * 1000 / 3)));
  private readonly recoveryIntervalMs = 30000;
  private lastRecoveryAt = 0;
  private activeJobs = 0;
  private completedJobs = 0;
  private failedJobs = 0;
  private lastJobAt: string | null = null;
  private lastJobStatus: 'completed' | 'failed' | 'retrying' | null = null;
  private lastErrorAt: string | null = null;
  private loops: Promise<void>[] = [];
  private providerGate: Promise<void> = Promise.resolve();
  private nextProviderRequestAt = 0;

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.loops = Array.from({ length: this.concurrency }, (_, slot) => this.runLoop(slot));
    console.log(`[IndexerWorker] Started with concurrency=${this.concurrency}, lease=${this.leaseSeconds}s.`);
  }

  public async stop(): Promise<void> {
    if (!this.isRunning && this.loops.length === 0) return;
    this.isRunning = false;
    console.log('[IndexerWorker] Stop requested; waiting for active jobs to finish.');
    await Promise.allSettled(this.loops);
    this.loops = [];
    console.log('[IndexerWorker] Worker stopped cleanly.');
  }

  public getStatus(): {
    isRunning: boolean;
    pollIntervalMs: number;
    concurrency: number;
    activeJobs: number;
    leaseSeconds: number;
    completedJobs: number;
    failedJobs: number;
    lastJobAt: string | null;
    lastJobStatus: 'completed' | 'failed' | 'retrying' | null;
    lastErrorAt: string | null;
  } {
    return {
      isRunning: this.isRunning,
      pollIntervalMs: this.pollIntervalMs,
      concurrency: this.concurrency,
      activeJobs: this.activeJobs,
      leaseSeconds: this.leaseSeconds,
      completedJobs: this.completedJobs,
      failedJobs: this.failedJobs,
      lastJobAt: this.lastJobAt,
      lastJobStatus: this.lastJobStatus,
      lastErrorAt: this.lastErrorAt,
    };
  }

  private async runLoop(slot: number): Promise<void> {
    const workerId = `${process.env.HOSTNAME || 'indexer'}:${process.pid}:${slot}:${randomUUID()}`;
    while (this.isRunning) {
      try {
        await this.recoverExpiredLeasesIfDue();
        const processed = await this.processNextJob(workerId);
        if (!processed && this.isRunning) {
          await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (err) {
        this.lastErrorAt = new Date().toISOString();
        logEvent('error', 'indexer.loop_error', {
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
        if (this.isRunning) await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
      }
    }
  }

  private async recoverExpiredLeasesIfDue(): Promise<void> {
    if (Date.now() - this.lastRecoveryAt < this.recoveryIntervalMs) return;
    // Avoid every concurrency slot issuing the same recovery query.
    this.lastRecoveryAt = Date.now();
    const recovered = await recoverStaleJobs();
    if (recovered > 0) console.warn(`[IndexerWorker] Requeued ${recovered} expired lease(s).`);
  }

  /** Enforces one shared provider-request start interval across all local worker slots. */
  private async waitForProviderTurn(): Promise<void> {
    let release!: () => void;
    const previous = this.providerGate;
    this.providerGate = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextProviderRequestAt - Date.now());
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.nextProviderRequestAt = Date.now() + this.delayBetweenRequestsMs;
    } finally {
      release();
    }
  }

  private async processNextJob(workerId: string): Promise<boolean> {
    let job: IndexJob | null;
    try {
      job = await claimNextJob(workerId, this.leaseSeconds);
    } catch (err) {
      console.warn('[IndexerWorker] Job claim failed:', err instanceof Error ? err.message : String(err));
      return false;
    }
    if (!job) return false;

    this.activeJobs++;
    console.log(`[IndexerWorker] ${workerId} claimed #${job.id} ${job.code} (attempt ${job.attempts}/${this.maxAttempts}).`);

    let leaseLost = false;
    let heartbeatBusy = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatBusy || leaseLost) return;
      heartbeatBusy = true;
      try {
        const renewed = await renewJobLease(job!.id, workerId, this.leaseSeconds);
        if (!renewed) {
          leaseLost = true;
          logEvent('warn', 'indexer.lease_lost', { jobId: job!.id });
        }
      } catch (err) {
        leaseLost = true;
        this.lastErrorAt = new Date().toISOString();
        logEvent('error', 'indexer.heartbeat_failed', {
          jobId: job!.id,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
      } finally {
        heartbeatBusy = false;
      }
    }, this.heartbeatMs);

    try {
      await this.waitForProviderTurn();
      if (leaseLost) return true;

      const metadata = await javtifulProvider.getMetadata(job.code);
      if (leaseLost) return true;

      await upsertVideoFromProvider({
        code: job.code,
        dump_chat_id: job.dump_chat_id,
        video_message_id: job.video_message_id,
        metadata,
        status: 'available',
      });

      const completed = await updateJobStatus(job.id, 'completed', null, null, workerId);
      if (completed) {
        this.completedJobs++;
        this.lastJobAt = new Date().toISOString();
        this.lastJobStatus = 'completed';
        logEvent('info', 'indexer.job_completed', { jobId: job.id, code: job.code });
      } else {
        logEvent('warn', 'indexer.job_finalize_skipped', { jobId: job.id });
      }
    } catch (err: unknown) {
      if (leaseLost) return true;
      const message = err instanceof Error ? err.message : String(err);

      if (err instanceof ProviderNotFoundError) {
        const markedFailed = await updateJobStatus(job.id, 'failed', `Not found on Javtiful: ${message}`, null, workerId);
        if (markedFailed) {
          this.failedJobs++;
          this.lastJobAt = new Date().toISOString();
          this.lastJobStatus = 'failed';
        }
        try {
          await upsertVideoFromProvider({
            code: job.code,
            dump_chat_id: job.dump_chat_id,
            video_message_id: job.video_message_id,
            status: 'failed',
          });
        } catch (persistErr) {
          console.warn(`[IndexerWorker] Could not persist not-found status for #${job.id}:`, persistErr);
        }
        logEvent('warn', 'indexer.provider_not_found', { jobId: job.id, code: job.code });
        return true;
      }

      const retryable = err instanceof ProviderTemporaryError || (err instanceof Error && err.name === 'AbortError');
      if (job.attempts < this.maxAttempts) {
        // Exponential backoff capped at five minutes; next_attempt_at is honored by the claim RPC.
        const backoffSeconds = Math.min(300, 15 * (2 ** Math.max(0, job.attempts - 1)));
        const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        const prefix = retryable ? 'Temporary provider error' : 'Processing error';
        await updateJobStatus(job.id, 'queued', `${prefix} (attempt ${job.attempts}): ${message}`, nextAttemptAt, workerId);
        this.lastJobAt = new Date().toISOString();
        this.lastJobStatus = 'retrying';
        logEvent('warn', 'indexer.job_retry_scheduled', {
          jobId: job.id,
          attempt: job.attempts,
          retryInSeconds: backoffSeconds,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
      } else {
        const markedFailed = await updateJobStatus(job.id, 'failed', `Max attempts (${this.maxAttempts}) exceeded: ${message}`, null, workerId);
        if (markedFailed) {
          this.failedJobs++;
          this.lastJobAt = new Date().toISOString();
          this.lastJobStatus = 'failed';
        }
        this.lastErrorAt = new Date().toISOString();
        logEvent('error', 'indexer.job_failed', {
          jobId: job.id,
          attempt: job.attempts,
          errorName: err instanceof Error ? err.name : 'UnknownError',
        });
      }
    } finally {
      clearInterval(heartbeat);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
    }
    return true;
  }
}

export const indexerWorker = new IndexerWorker();
