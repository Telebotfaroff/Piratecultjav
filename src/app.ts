import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config, validateConfig } from './config.ts';
import { checkSupabaseConnection } from './database/supabase.ts';
import { countVideos, searchVideos, getVideoById, toPublicVideo } from './services/videos.ts';
import { countJobs, createIndexJob, getRecentJobs, retryJob } from './services/indexJobs.ts';
import { countUsers, getBroadcastUserIds } from './services/users.ts';
import { javtifulProvider } from './providers/javtiful/index.ts';
import { extractCodes, normalizeCode } from './services/code.ts';
import { getAllSettings, setSetting } from './services/settings.ts';
import { isBotActive, getBot, getBotUsername } from './bot/index.ts';
import { indexerWorker } from './workers/indexer.ts';
import { getScreenshotImagesByCode, getScreenshotImageById } from './services/screenshotImages.ts';

const adminSessions = new Map<string, number>();

// Lightweight in-process rate limiter for public catalog endpoints.
// This protects the persistent server without Redis or another external dependency.
const publicRateBuckets = new Map<string, { windowStart: number; count: number }>();
const PUBLIC_RATE_WINDOW_MS = 60_000;
const PUBLIC_RATE_MAX = 120;
const PUBLIC_SEARCH_MAX_LENGTH = 120;

function publicRateLimit(req: Request, res: Response, next: express.NextFunction): void {
  // Do not trust a client-supplied X-Forwarded-For header. Configure Express
  // trust proxy explicitly at deployment time if requests arrive through a trusted proxy.
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const bucket = publicRateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= PUBLIC_RATE_WINDOW_MS) {
    publicRateBuckets.set(ip, { windowStart: now, count: 1 });
    return next();
  }
  bucket.count++;
  if (bucket.count > PUBLIC_RATE_MAX) {
    res.setHeader('Retry-After', '60');
    res.status(429).json({ ok: false, error: 'Too many requests. Please try again shortly.' });
    return;
  }
  next();
}

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie || '';
  const item = header.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function adminOnly(req: Request, res: Response, next: express.NextFunction): void {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const cookieToken = getCookie(req, 'pc_admin');
  const sessionToken = bearer || cookieToken;

  if (sessionToken) {
    const expiresAt = adminSessions.get(sessionToken);
    if (expiresAt && expiresAt > Date.now()) {
      adminSessions.set(sessionToken, Date.now() + config.adminSessionTtlMs);
      return next();
    }
    adminSessions.delete(sessionToken);
  }

  // Direct API-key access is useful for scripts/automation and never gets sent to the browser.
  const apiKey = req.headers['x-admin-key'];
  if (typeof apiKey === 'string' && config.adminApiKey && safeEqual(apiKey, config.adminApiKey)) {
    return next();
  }

  res.status(401).json({ ok: false, error: 'Admin authentication required' });
}

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  app.post('/api/auth/login', publicRateLimit, (req: Request, res: Response) => {
    if (!config.adminApiKey) {
      return res.status(503).json({ ok: false, error: 'ADMIN_API_KEY is not configured' });
    }

    const supplied = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!safeEqual(supplied, config.adminApiKey)) {
      return res.status(401).json({ ok: false, error: 'Invalid admin key' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + config.adminSessionTtlMs);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `pc_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(config.adminSessionTtlMs / 1000)}${secure}`
    );
    return res.json({ ok: true });
  });

  app.post('/api/auth/logout', adminOnly, (req: Request, res: Response) => {
    const token = getCookie(req, 'pc_admin');
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', 'pc_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return res.json({ ok: true });
  });

  app.get('/api/auth/status', (req: Request, res: Response) => {
    const token = getCookie(req, 'pc_admin');
    const expiresAt = token ? adminSessions.get(token) : undefined;
    return res.json({ ok: true, authenticated: Boolean(expiresAt && expiresAt > Date.now()) });
  });

  // Non-negotiable requirement: /health endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      service: 'PiratecultJAV',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Readiness endpoint: unlike /health, this verifies the critical database dependency.
  // It is suitable for load balancers and deployment platforms that need to know
  // whether the instance can actually serve application traffic.
  app.get('/ready', async (_req: Request, res: Response) => {
    const started = Date.now();
    try {
      const validation = validateConfig();
      if (!validation.valid) {
        return res.status(503).json({
          ok: false,
          ready: false,
          reason: 'configuration',
          missing: validation.missing,
          latencyMs: Date.now() - started,
        });
      }

      const supabase = await checkSupabaseConnection();
      const botReady = isBotActive();

      if (!supabase.connected || !botReady) {
        return res.status(503).json({
          ok: false,
          ready: false,
          dependencies: {
            supabase: supabase.connected,
            bot: botReady,
          },
          latencyMs: Date.now() - started,
        });
      }

      return res.status(200).json({
        ok: true,
        ready: true,
        dependencies: {
          supabase: true,
          bot: true,
        },
        latencyMs: Date.now() - started,
      });
    } catch (err) {
      return res.status(503).json({
        ok: false,
        ready: false,
        reason: 'dependency_check_failed',
        latencyMs: Date.now() - started,
      });
    }
  });

  // System status and diagnostics
  app.get('/api/status', adminOnly, async (_req: Request, res: Response) => {
    const startTime = Date.now();
    const configValidation = validateConfig();
    const supabaseStatus = await checkSupabaseConnection();

    let counts = { users: 0, videos: 0, jobs: { queued: 0, processing: 0, completed: 0, failed: 0, total: 0 } };
    if (supabaseStatus.connected) {
      try {
        const [uCount, vCount, jCounts] = await Promise.all([
          countUsers(),
          countVideos(),
          countJobs(),
        ]);
        counts = { users: uCount, videos: vCount, jobs: jCounts };
      } catch (err) {
        console.warn('Failed querying counts:', err);
      }
    }

    res.json({
      service: 'PiratecultJAV',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      config: {
        supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseSecretKey),
        botTokenConfigured: Boolean(config.botToken),
        dumpChatId: config.dumpChatId,
        adminCount: config.adminIds.length,
        javtifulBaseUrl: config.javtifulBaseUrl,
        validation: configValidation,
      },
      supabase: supabaseStatus,
      bot: {
        active: isBotActive(),
      },
      worker: indexerWorker.getStatus(),
      counts,
      latencyMs: Date.now() - startTime,
    });
  });

  // Jobs API: List jobs
  app.get('/api/jobs', adminOnly, async (req: Request, res: Response) => {
    try {
      const statusFilter = (req.query.status as string) || undefined;
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const jobs = await getRecentJobs(statusFilter, limit);
      res.json({ ok: true, jobs });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Jobs API: Create a manual or test job
  app.post('/api/jobs/create', adminOnly, async (req: Request, res: Response) => {
    try {
      const { code, dumpChatId, videoMessageId } = req.body;
      if (!code) {
        return res.status(400).json({ ok: false, error: 'code is required' });
      }

      const norm = normalizeCode(code);
      if (!norm) {
        return res.status(400).json({ ok: false, error: 'Invalid JAV code format' });
      }

      const vMsgId = parseInt(videoMessageId || String(Math.floor(Date.now() / 1000)), 10);
      const dChatId = dumpChatId || config.dumpChatId;

      const result = await createIndexJob({
        code: norm,
        dumpChatId: dChatId,
        videoMessageId: vMsgId,
      });

      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Jobs API: Retry job
  app.post('/api/jobs/retry/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const jobId = parseInt(req.params.id, 10);
      const job = await retryJob(jobId);
      res.json({ ok: true, job });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Screenshot gallery API. Telegram file IDs and channel identifiers stay server-side.
  app.get('/api/screenshots/:code', publicRateLimit, async (req: Request, res: Response) => {
    try {
      const code = normalizeCode(String(req.params.code || ''));
      if (!code) return res.status(400).json({ ok: false, error: 'Invalid video code' });

      const images = await getScreenshotImagesByCode(code, 60);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
      return res.json({
        ok: true,
        code,
        total: images.length,
        images: images.map(image => ({
          id: image.id,
          code: image.code,
          width: image.width,
          height: image.height,
          createdAt: image.created_at,
          url: '/api/screenshots/' + image.id + '/image',
        })),
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Securely proxy a known indexed Telegram photo. Never send Telegram file URLs/tokens to the browser.
  app.get('/api/screenshots/:id/image', publicRateLimit, async (req: Request, res: Response) => {
    try {
      const image = await getScreenshotImageById(String(req.params.id || ''));
      if (!image) return res.status(404).send('Screenshot not found');

      const bot = getBot();
      if (!bot) return res.status(503).send('Telegram image service is unavailable');

      const fileUrl = await bot.telegram.getFileLink(image.file_id);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      let upstream: globalThis.Response;
      try {
        upstream = await fetch(fileUrl.toString(), { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!upstream.ok) return res.status(502).send('Telegram image could not be retrieved');
      const upstreamType = (upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
        return res.status(413).send('Screenshot image is too large');
      }

      // Telegram's file server can return application/octet-stream even for valid photos.
      // Validate the actual file signature instead of trusting only the response header.
      let contentType = upstreamType;
      if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        contentType = 'image/jpeg';
      } else if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        contentType = 'image/png';
      } else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
        contentType = 'image/webp';
      } else if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
        return res.status(415).send('Unsupported screenshot image type');
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(bytes.length));
      res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.status(200).send(bytes);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn('[Screenshots] Image proxy failed:', errMsg);
      return res.status(502).send('Unable to load screenshot image');
    }
  });

  // Public video details API
  app.get('/api/videos/:id', publicRateLimit, async (req: Request, res: Response) => {
    try {
      const video = await getVideoById(req.params.id);

      if (!video || video.status !== 'available') {
        return res.status(404).json({ ok: false, error: 'Video not found' });
      }

      const botUsername = await getBotUsername();
      const botUrl = botUsername
        ? 'https://t.me/' + botUsername + '?start=' + encodeURIComponent('v_' + video.id)
        : null;

      return res.json({
        ok: true,
        video: toPublicVideo(video),
        botUrl,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Videos API: Search & browse
  app.get('/api/videos', publicRateLimit, async (req: Request, res: Response) => {
    try {
      const query = ((req.query.q as string) || '').trim().slice(0, PUBLIC_SEARCH_MAX_LENGTH);
      const limit = Math.min(Math.max(parseInt((req.query.limit as string) || '20', 10) || 20, 1), 50);
      const offset = Math.min(Math.max(parseInt((req.query.offset as string) || '0', 10) || 0, 0), 100000);

      const result = await searchVideos(query, limit, offset);
      res.json({ ok: true, videos: result.videos.map(toPublicVideo), total: result.total });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Public image proxy endpoint. Only known public image hosts are allowed.
  // This prevents the endpoint from becoming an open SSRF proxy.
  app.get('/api/proxy/image', publicRateLimit, async (req: Request, res: Response) => {
    const ALLOWED_IMAGE_HOSTS = [
      'pics.dmm.co.jp',
      'www.javtiful.com',
      'javtiful.com',
    ];
    const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

    try {
      const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
      if (!rawUrl) {
        return res.status(400).send('Missing url parameter');
      }

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return res.status(400).send('Invalid url parameter');
      }

      if (parsed.protocol !== 'https:') {
        return res.status(400).send('Only HTTPS image URLs are allowed');
      }

      const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
      const allowed = ALLOWED_IMAGE_HOSTS.some(
        host => hostname === host || hostname.endsWith('.' + host)
      );

      if (!allowed) {
        return res.status(403).send('Image host is not allowed');
      }

      // Prevent credentials and unusual URL forms from being used against the proxy.
      if (parsed.username || parsed.password || parsed.port) {
        return res.status(400).send('Invalid image URL');
      }

      let upstream: globalThis.Response | null = null;
      let currentUrl = parsed.toString();

      // Follow only a few redirects, validating every destination against the allowlist.
      for (let redirectCount = 0; redirectCount <= 3; redirectCount++) {
        const current = new URL(currentUrl);
        const currentHost = current.hostname.toLowerCase().replace(/\.$/, '');
        const currentAllowed = ALLOWED_IMAGE_HOSTS.some(
          host => currentHost === host || currentHost.endsWith('.' + host)
        );
        if (current.protocol !== 'https:' || !currentAllowed || current.username || current.password || current.port) {
          return res.status(403).send('Image redirect target is not allowed');
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9000);

        try {
          upstream = await fetch(current.toString(), {
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*;q=0.9',
            },
          });
        } finally {
          clearTimeout(timeoutId);
        }

        if (upstream.status < 300 || upstream.status >= 400) break;

        const location = upstream.headers.get('location');
        if (!location || redirectCount === 3) {
          return res.status(502).send('Too many or invalid image redirects');
        }
        currentUrl = new URL(location, current).toString();
      }

      if (!upstream || !upstream.ok) {
        return res.status(upstream?.status || 502).send(`Upstream returned ${upstream?.status || 502}`);
      }

      if (upstream.url && upstream.url.includes('now_printing')) {
        return res.status(404).send('Placeholder image');
      }

      const contentType = (upstream.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        return res.status(415).send('Upstream response is not an image');
      }

      const declaredLength = Number(upstream.headers.get('content-length') || '0');
      if (declaredLength > MAX_IMAGE_BYTES) {
        return res.status(413).send('Image is too large');
      }

      const body = await upstream.arrayBuffer();
      if (body.byteLength > MAX_IMAGE_BYTES) {
        return res.status(413).send('Image is too large');
      }

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(Buffer.from(body));
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return res.status(502).send(`Proxy fetch failed: ${errMsg}`);
    }
  });

  // Provider Test API: Live scraper runner for any JAV code
  app.post('/api/provider/test', adminOnly, async (req: Request, res: Response) => {
    const start = Date.now();
    try {
      const { code } = req.body;
      if (!code) {
        return res.status(400).json({ ok: false, error: 'code is required' });
      }

      const normalized = normalizeCode(code);
      if (!normalized) {
        return res.status(400).json({ ok: false, error: `Invalid code format: ${code}` });
      }

      const metadata = await javtifulProvider.getMetadata(normalized);
      const latencyMs = Date.now() - start;

      res.json({
        ok: true,
        code: normalized,
        latencyMs,
        metadata,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(400).json({
        ok: false,
        latencyMs: Date.now() - start,
        error: errMsg,
      });
    }
  });

  // Simulator API: Simulates a Telegram Dump Channel post
  app.post('/api/simulator/dump-post', adminOnly, async (req: Request, res: Response) => {
    try {
      const { caption, messageId, dumpChatId } = req.body;
      if (!caption) {
        return res.status(400).json({ ok: false, error: 'caption is required' });
      }

      const codes = extractCodes(caption);
      if (codes.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'No valid JAV codes found in caption. Try e.g. "ADN-001" or "ROE-327"',
        });
      }

      const primaryCode = codes[0];
      const targetMessageId = parseInt(messageId || String(Math.floor(Date.now() / 1000)), 10);
      const targetChatId = dumpChatId || config.dumpChatId;

      const jobResult = await createIndexJob({
        code: primaryCode,
        dumpChatId: targetChatId,
        videoMessageId: targetMessageId,
      });

      res.json({
        ok: true,
        extractedCodes: codes,
        primaryCode,
        dumpChatId: targetChatId,
        videoMessageId: targetMessageId,
        job: jobResult.job,
        created: jobResult.created,
        reason: jobResult.reason,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Admin broadcast API
  app.post('/api/broadcast', adminOnly, async (req: Request, res: Response) => {
    try {
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
      if (!message) return res.status(400).json({ ok: false, error: 'message is required' });
      if (message.length > 4096) return res.status(400).json({ ok: false, error: 'message exceeds Telegram 4096-character limit' });

      const bot = getBot();
      if (!bot) return res.status(503).json({ ok: false, error: 'Telegram bot is not active' });

      const userIds = await getBroadcastUserIds();
      let sent = 0;
      let failed = 0;
      const failures: number[] = [];

      for (let i = 0; i < userIds.length; i += 25) {
        const batch = userIds.slice(i, i + 25);
        await Promise.all(batch.map(async (userId) => {
          try {
            await bot.telegram.sendMessage(userId, message);
            sent++;
          } catch {
            failed++;
            if (failures.length < 50) failures.push(userId);
          }
        }));
        if (i + 25 < userIds.length) await new Promise(resolve => setTimeout(resolve, 1100));
      }

      res.json({ ok: true, total: userIds.length, sent, failed, failures });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Force-sub channel management API
  app.get('/api/force-sub/channels', adminOnly, async (_req: Request, res: Response) => {
    try {
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ ok: true, channels: data || [] });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/force-sub/channels', adminOnly, async (req: Request, res: Response) => {
    try {
      const { channelId, title, inviteLink, requestMode, isActive } = req.body || {};
      if (!channelId || !title) return res.status(400).json({ ok: false, error: 'channelId and title are required' });
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').upsert({
        channel_id: String(channelId).trim(),
        title: String(title).trim(),
        invite_link: inviteLink ? String(inviteLink).trim() : null,
        request_mode: Boolean(requestMode),
        is_active: isActive !== false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'channel_id' }).select('*').single();
      if (error) throw error;
      res.json({ ok: true, channel: data });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/force-sub/channels/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const { title, inviteLink, requestMode, isActive } = req.body || {};
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (title !== undefined) updates.title = String(title).trim();
      if (inviteLink !== undefined) updates.invite_link = inviteLink ? String(inviteLink).trim() : null;
      if (requestMode !== undefined) updates.request_mode = Boolean(requestMode);
      if (isActive !== undefined) updates.is_active = Boolean(isActive);
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').update(updates).eq('id', req.params.id).select('*').single();
      if (error) throw error;
      res.json({ ok: true, channel: data });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/force-sub/channels/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { error } = await supabase.from('force_sub_channels').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Settings API
  app.get('/api/settings', adminOnly, async (_req: Request, res: Response) => {
    try {
      const settings = await getAllSettings();
      res.json({ ok: true, settings });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/settings', adminOnly, async (req: Request, res: Response) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
      await setSetting(key, value);
      res.json({ ok: true, message: `Setting ${key} updated` });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // Schema SQL API
  app.get('/api/schema/sql', adminOnly, (_req: Request, res: Response) => {
    try {
      const sqlPath = path.resolve(process.cwd(), 'supabase/migrations/001_initial_schema.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf-8');
        return res.json({ ok: true, sql });
      }
      res.status(404).json({ ok: false, error: 'Schema file not found' });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return app;
}
