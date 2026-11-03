import path from 'path';
import express from 'express';
import { createApp } from './src/app.ts';
import { config } from './src/config.ts';
import { indexerWorker } from './src/workers/indexer.ts';
import { startBotPolling, stopBotRuntime } from './src/bot/index.ts';
import { runDatabaseMigrations } from './src/database/migrate.ts';

async function startServer() {
  // Prepare a fresh Supabase PostgreSQL database before any bot or API code runs.
  await runDatabaseMigrations();
  const app = createApp();
  const port = config.port || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    // Mount Vite dev server in development
    const fs = await import('fs');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);

    // Serve transformed index.html for client-side routing
    app.use('*', async (req, res, next) => {
      const url = req.originalUrl;
      try {
        const indexPath = path.resolve(process.cwd(), 'index.html');
        let template = fs.readFileSync(indexPath, 'utf-8');
        template = await vite.transformIndexHtml(url, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    // Serve static frontend files in production
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distPath, 'index.html'));
    });
  }

  // Start background services
  indexerWorker.start();
  
  const httpServer = app.listen(port, '0.0.0.0', () => {
    console.log(`[PiratecultJAV] Server running on http://0.0.0.0:${port}`);
    console.log(`[PiratecultJAV] Health check available at http://0.0.0.0:${port}/health`);

    if (config.botToken || config.backupBotToken) {
      // Long polling is the default transport in every environment. WEBHOOK_*
      // variables are intentionally ignored so Render cannot accidentally switch
      // this deployment back to webhook mode.
      console.log('[Server] Starting Telegram bot with long polling.');
      startBotPolling().catch(err => {
        console.warn('[Server] Could not initialize Telegram bot polling:', err instanceof Error ? err.message : String(err));
      });
    } else {
      console.log('[Server] BOT_TOKEN / BACKUP_BOT_TOKEN not provided; Telegram bot inactive.');
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] ${signal} received; beginning graceful shutdown.`);

    const forceExitTimer = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out; forcing exit.');
      httpServer.closeAllConnections();
      process.exit(1);
    }, 15_000);
    forceExitTimer.unref();

    // Stop accepting new HTTP requests, stop Telegram updates, and let claimed
    // index jobs finish while their lease heartbeats remain active.
    const httpClosed = new Promise<void>(resolve => {
      httpServer.close(() => resolve());
    });

    await Promise.allSettled([
      stopBotRuntime(),
      indexerWorker.stop(),
      httpClosed,
    ]);

    clearTimeout(forceExitTimer);
    console.log('[Server] Graceful shutdown complete.');
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.once('SIGINT', () => { void shutdown('SIGINT'); });
}

startServer().catch(err => {
  console.error('[PiratecultJAV] Fatal startup error:', err);
  process.exit(1);
});
