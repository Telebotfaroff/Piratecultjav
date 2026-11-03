import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

const REQUIRED_ENV = ['DATABASE_URL', 'API_ID', 'API_HASH', 'SESSION_ENCRYPTION_KEY'] as const;

export class HistoricalIndexerProcess {
  private child: ChildProcess | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private restartDelayMs = 5_000;

  start(): void {
    if (process.env.HISTORICAL_INDEXER_ENABLED?.toLowerCase() !== 'true') {
      console.log('[HistoricalIndexer] Disabled. Set HISTORICAL_INDEXER_ENABLED=true after configuring the Pyrogram session.');
      return;
    }

    const missing = REQUIRED_ENV.filter((key) => !process.env[key]?.trim());
    if (missing.length) {
      console.log(
        `[HistoricalIndexer] Not started; configure ${missing.join(', ')} to enable the Pyrogram worker.`,
      );
      return;
    }

    this.stopped = false;
    this.launch();
  }

  private launch(): void {
    if (this.stopped || this.child) return;

    const python = process.env.PYTHON_BIN || 'python3';
    const script = path.resolve(process.cwd(), 'workers/historical_indexer/main.py');
    console.log('[HistoricalIndexer] Starting Pyrogram historical indexing worker.');

    const child = spawn(python, ['-u', script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    this.child = child;

    child.once('error', (error) => {
      console.error('[HistoricalIndexer] Failed to launch worker:', error.message);
    });

    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;

      console.error(
        `[HistoricalIndexer] Worker exited (code=${code ?? 'null'}, signal=${signal ?? 'none'}).`,
      );
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.stopped || this.restartTimer) return;
    const delay = this.restartDelayMs;
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, 5 * 60_000);
    console.warn(`[HistoricalIndexer] Restarting worker in ${Math.round(delay / 1000)} seconds.`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.child = null;
      return;
    }

    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 10_000);
      forceKill.unref?.();

      child.once('exit', () => {
        clearTimeout(forceKill);
        resolve();
      });
      child.kill('SIGTERM');
    });

    if (this.child === child) this.child = null;
  }
}

export const historicalIndexerProcess = new HistoricalIndexerProcess();
