import { randomBytes } from 'node:crypto';
import type { Express } from 'express';
import { Telegraf, Markup } from 'telegraf';
import { config, isAdmin } from '../config.ts';
import { normalizeCode, extractCodes, cleanActressList, cleanTitle } from '../services/code.ts';
import { searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus } from '../services/videos.ts';
import { createIndexJob, countJobs, getRecentJobs, retryJob } from '../services/indexJobs.ts';
import { upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getUser, getUserDashboard, getReferralLeaderboard, redeemPromoCode, createPromoCode, listPremiumPayments, listPromoCodes, setPromoCodeActive, consumeVideoDownload, refundVideoDownload, getDownloadQuotaSettings, setDownloadQuotaSettings, registerReferral, completeReferral, setUserPlan } from '../services/users.ts';
import { checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink } from '../services/forceSub.ts';
import { getAdminSession, setAdminSession, clearAdminSession } from '../services/adminSessions.ts';
import { javtifulProvider } from '../providers/javtiful/index.ts';
import { recordMissedCode, listMissedCodes, removeMissedCode } from '../services/missedCodes.ts';
import { sendDumpVideoToUser, storeThumbnailInDumpChannel } from '../services/dump.ts';
import { installMessageDeleteTimer } from '../services/messageDeleteTimer.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { classifyTelegramError, withTelegramRetry } from '../services/telegramErrors.ts';
import { recordVideoDeliveryEvent, getVideoDeliveryAnalytics } from '../services/videoAnalytics.ts';
import { deliverVideoToUser, downloadAllSearchResults, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery, showForceSubAdminMenu, showAdminSettings, formatTimer } from './helpers.ts';
import { registerPaymentEvents } from './events/payments.ts';
import { getActiveBotRole as getStoredActiveBotRole, setActiveBotRole } from './state.ts';
import { getPremiumPackages, savePremiumPackage, removePremiumPackage, togglePremiumPackage, sendPremiumStore, sendPremiumInvoice } from './premium.ts';
import { registerTelegramErrorHandler } from './middleware/errorHandler.ts';
import { registerUserTrackingMiddleware } from './middleware/userTracking.ts';

let botInstance: Telegraf | null = null;
let isPollingActive = false;
let isWebhookActive = false;
let webhookApp: Express | null = null;
let webhookRouteRegistered = false;
setActiveBotRole(config.activeBot);

const START_IMAGES_MANIFEST_URL = 'https://raw.githubusercontent.com/telebottg7-sudo/Cosplay.image/main/image/manifest.json';
const START_IMAGES_RAW_BASE = 'https://raw.githubusercontent.com/telebottg7-sudo/Cosplay.image/main/image';
type StartImageChunk = { path: string; chunk: string };
let cachedStartImageChunks: StartImageChunk[] | null = null;
const loadedStartImageChunks = new Set<string>();
const cachedStartImageLinks: string[] = [];
let lastStartImageUrl: string | null = null;

async function getRandomStartImageUrl(): Promise<string | null> {
  try {
    if (!cachedStartImageChunks) {
      const response = await fetch(START_IMAGES_MANIFEST_URL, { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error(`Image manifest returned HTTP ${response.status}`);
      const manifest = await response.json() as {
        posts?: Array<{ path?: unknown; chunks?: unknown }>;
      };
      cachedStartImageChunks = [];
      if (Array.isArray(manifest.posts)) {
        for (const post of manifest.posts) {
          if (typeof post.path !== 'string' || !Array.isArray(post.chunks)) continue;
          for (const chunk of post.chunks) {
            if (typeof chunk === 'string' && /^[a-zA-Z0-9._-]+\.json$/.test(chunk)) {
              cachedStartImageChunks.push({ path: post.path, chunk });
            }
          }
        }
      }
      // Shuffle the archive chunk order once, so each request gradually samples different posts.
      for (let i = cachedStartImageChunks.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [cachedStartImageChunks[i], cachedStartImageChunks[j]] = [cachedStartImageChunks[j], cachedStartImageChunks[i]];
      }
    }

    // Fetch only one new archive chunk per /start instead of making dozens of requests at once.
    // Retry a few chunks if one is temporarily unavailable.
    let attempts = 0;
    while (attempts < 3 && loadedStartImageChunks.size < cachedStartImageChunks.length) {
      const nextChunk = cachedStartImageChunks.find((item) => !loadedStartImageChunks.has(`${item.path}/${item.chunk}`));
      if (!nextChunk) break;
      const key = `${nextChunk.path}/${nextChunk.chunk}`;
      loadedStartImageChunks.add(key);
      attempts++;
      try {
        const chunkUrl = `${START_IMAGES_RAW_BASE}/${encodeURIComponent(nextChunk.path)}/${encodeURIComponent(nextChunk.chunk)}`;
        const chunkResponse = await fetch(chunkUrl, { signal: AbortSignal.timeout(5000) });
        if (!chunkResponse.ok) continue;
        const chunkData: unknown = await chunkResponse.json();
        if (Array.isArray(chunkData)) {
          for (const value of chunkData) {
            if (typeof value === 'string' && /^https?:\/\//i.test(value) && !cachedStartImageLinks.includes(value)) {
              cachedStartImageLinks.push(value);
            }
          }
        }
      } catch {
        // Skip unavailable chunks; the next start can still use cached images.
      }
    }

    if (!cachedStartImageLinks.length) return null;
    const candidates = cachedStartImageLinks.filter((url) => url !== lastStartImageUrl);
    const pool = candidates.length ? candidates : cachedStartImageLinks;
    const selected = pool[Math.floor(Math.random() * pool.length)];
    lastStartImageUrl = selected;
    return selected;
  } catch (err) {
    console.warn('[StartImage] Could not load image archive:', err instanceof Error ? err.message : String(err));
    return null;
  }
}
function tokenForRole(role: 'primary' | 'backup'): string {
  return role === 'backup' ? config.backupBotToken : config.botToken;
}

function availableRole(preferred: 'primary' | 'backup'): 'primary' | 'backup' | null {
  if (tokenForRole(preferred)) return preferred;
  const fallback = preferred === 'primary' ? 'backup' : 'primary';
  return tokenForRole(fallback) ? fallback : null;
}

function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  registerPaymentEvents(bot);

  // Automatically delete bot-created messages according to the admin-configured timer.
  // Dump-channel storage messages are excluded so indexed videos remain available.
  installMessageDeleteTimer(bot);

  registerTelegramErrorHandler(bot);

  // 1. User tracking & blocked filter middleware
  registerUserTrackingMiddleware(bot);

  // Let an admin opt a requester into a one-time alert when a matching catalog item appears.
  bot.action(/^notfound:watch:([a-f0-9]+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
    const requestId = ctx.match[1];
    const alerts = await getSetting<any[]>('not_found_alerts', []);
    const request = Array.isArray(alerts) ? alerts.find((item) => item?.id === requestId) : null;
    if (!request) return ctx.answerCbQuery('This request has expired.', { show_alert: true });
    const pending = await getSetting<any[]>('pending_not_found_notifications', []);
    const requests = Array.isArray(pending) ? pending : [];
    if (!requests.some((item) => item?.id === requestId)) {
      requests.push(request);
      await setSetting('pending_not_found_notifications', requests.slice(-500));
    }
    await ctx.answerCbQuery('We will notify the user when a match is added.');
    return ctx.editMessageReplyMarkup({
      inline_keyboard: [[Markup.button.callback('🔔 User will be notified when added', 'notfound:watching')]],
    }).catch(() => undefined);
  });

  bot.action('notfound:watching', async (ctx) => ctx.answerCbQuery('This request is already being watched.'));

  // Poll pending requests in the settings store and notify users once a matching catalog result exists.
  if (!(globalThis as any).__pendingNotFoundWatcher) {
    (globalThis as any).__pendingNotFoundWatcher = setInterval(async () => {
      try {
        const pending = await getSetting<any[]>('pending_not_found_notifications', []);
        if (!Array.isArray(pending) || pending.length === 0) return;
        const remaining: any[] = [];
        for (const request of pending) {
          if (!request || !Number.isSafeInteger(Number(request.userId)) || !request.query) continue;
          try {
            const result = await searchVideos(String(request.query), 10, 0);
            if (!result.videos.length) {
              remaining.push(request);
              continue;
            }
            const query = String(request.query).trim().toLowerCase();
            const match = result.videos.find((video: any) =>
              String(video.code || '').toLowerCase() === query ||
              String(video.title || '').toLowerCase().includes(query) ||
              query.includes(String(video.code || '').toLowerCase())
            );
            if (!match) {
              remaining.push(request);
              continue;
            }
            const me = await bot.telegram.getMe();
            const safe = (value: unknown) => escapeHtml(value ?? '—');
            await bot.telegram.sendMessage(
              Number(request.userId),
              '🎉 <b>Your requested video has been added!</b>\n\n🎬 <b>' + safe(match.code) + '</b> — ' + safe(match.title) +
              '\n\nTap below to get it.',
              {
                parse_mode: 'HTML',
                ...Markup.inlineKeyboard([[Markup.button.url('🎬 Get Video', 'https://t.me/' + me.username + '?start=' + encodeURIComponent(String(match.code)))]])
              },
            );
          } catch (err) {
            // Keep it pending on temporary database or Telegram errors.
            remaining.push(request);
            console.warn('[NotFoundWatch] Check failed:', err instanceof Error ? err.message : String(err));
          }
        }
        await setSetting('pending_not_found_notifications', remaining.slice(-500));
      } catch (err) {
        console.warn('[NotFoundWatch] Poll failed:', err instanceof Error ? err.message : String(err));
      }
    }, 120_000);
    (globalThis as any).__pendingNotFoundWatcher.unref?.();
  }

  // 2. Start command
  bot.command('dashboard', async (ctx) => sendUserPlan(ctx));
  bot.command('leaderboard', async (ctx) => sendReferralLeaderboard(ctx));
  bot.command('plan', async (ctx) => sendUserPlan(ctx));

bot.command('start', async (ctx) => {
    const startText = 'text' in ctx.message ? ctx.message.text : '';
    let payload = startText.replace(/^\/start(?:@\w+)?\s*/i, '').trim();

    if (payload && /^ref_\d+$/i.test(payload) && ctx.from) {
      const referrerId = Number(payload.slice(4));
      try {
        const referral = await registerReferral(referrerId, ctx.from.id);
        if (referral.success) {
          await ctx.reply('✅ Referral tracked! The inviter will receive +1 day of unlimited access after you successfully receive your first video.');
        }
      } catch (err) {
        console.warn('[Referral] Failed:', err instanceof Error ? err.message : String(err));
      }
      // Referral payload is not a video code.
      if (payload.toLowerCase().startsWith('ref_')) {
        payload = '';
      }
    }

    if (payload) {
      const isVideoDeepLink = /^v_\d+$/i.test(payload);
      return deliverVideoToUser(bot, ctx, isVideoDeepLink ? payload.slice(2) : payload, isVideoDeepLink ? 'deep_link' : 'unknown');
    }

    const welcome = [
      '✦ <b>PIRATECULTJAV</b> ✦',
      '',
      '👋 Welcome! Search videos by code or keyword.',
      '📥 Open a video from the website using <b>Get Video</b>.',
      '',
      '💡 Try: <code>ADN-001</code> · <code>STAR-765</code>',
      '',
      '<i>Choose an option below.</i>',
    ].join('\\n');

    const startKeyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔎 Search Catalog', 'menu:search')],
      [
        Markup.button.callback('📊 Account', 'user:plan'),
        Markup.button.callback('💎 Premium', 'premium:store'),
        Markup.button.callback('🎟️ Promo', 'user:promo'),
      ],
      [
        Markup.button.callback('🔗 Refer', 'user:referral'),
        Markup.button.callback('🏆 Leaderboard', 'user:leaderboard'),
      ],
      [Markup.button.callback('❓ Help & Support', 'menu:help')],
      [Markup.button.url('🌐 Open Website', 'https://piratecultjav.onrender.com/')],
    ]);

    // Send a shuffled archive image with the welcome caption. Fall back to text if unavailable.
    const startImageUrl = await getRandomStartImageUrl();
    if (startImageUrl) {
      try {
        return await ctx.replyWithPhoto(startImageUrl, {
          caption: welcome,
          parse_mode: 'HTML',
          ...startKeyboard,
        });
      } catch (err) {
        console.warn('[StartImage] Telegram could not send selected image:', err instanceof Error ? err.message : String(err));
      }
    }
    return ctx.reply(welcome, { parse_mode: 'HTML', ...startKeyboard });
  });

  // Help and search shortcuts use the same navigation style as the home screen.
  bot.command('help', async (ctx) => {
    const helpText = [
      '❓ <b>PIRATECULTJAV HELP</b>',
      '',
      '🔎 <b>Search:</b> send a video code or keyword, or tap Search Catalog.',
      '🎬 <b>Website delivery:</b> tap Get Video on the website to open the matching video here.',
      '📊 <b>Account:</b> check your plan, daily allowance, and referrals.',
      '',
      '<b>Examples</b>',
      '<code>ADN-001</code>',
      '<code>STAR-765</code>',
      '',
      'Use the buttons below to navigate.'
    ].join('\n');
    return ctx.reply(helpText, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔎 Search Catalog', 'menu:search')],
        [Markup.button.callback('📊 My Account', 'user:plan'), Markup.button.callback('🏠 Home', 'menu:home')],
      ]),
    });
  });

  bot.command('search', async (ctx) => {
    return ctx.reply(
      '🔎 <b>Search the catalog</b>\n\nSend a video code (for example <code>ADN-001</code>) or a keyword in your next message.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'menu:home')]]) },
    );
  });

  bot.action('menu:home', async (ctx) => {
    await ctx.answerCbQuery();
    const welcome = [
      '╭━━━━━━━━━━━━━━━━━━━━╮',
      '      ✦ <b>PIRATECULTJAV</b> ✦',
      '╰━━━━━━━━━━━━━━━━━━━━╯',
      '',
      '👋 Welcome to your video library assistant.',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '⚡ <b>WHAT WOULD YOU LIKE TO DO?</b>',
      '',
      '🔎 Search the catalog by code or keyword.',
      '🎬 Open a video using the website’s Get Video button.',
      '📊 Check your plan and daily allowance.',
      '',
      '💡 <b>Try a code</b>',
      '<code>ADN-001</code>  ·  <code>STAR-765</code>',
      '',
      '<i>Choose an option below to get started.</i>'
    ].join('\n');
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔎 Search Catalog', 'menu:search')],
      [
        Markup.button.callback('📊 Account', 'user:plan'),
        Markup.button.callback('💎 Premium', 'premium:store'),
        Markup.button.callback('🎟️ Promo', 'user:promo'),
      ],
      [
        Markup.button.callback('🔗 Refer', 'user:referral'),
        Markup.button.callback('🏆 Leaderboard', 'user:leaderboard'),
      ],
      [Markup.button.callback('❓ Help & Support', 'menu:help')],
      [Markup.button.url('🌐 Open Website', 'https://piratecultjav.onrender.com/')],
    ]);
    return ctx.editMessageText(welcome, { parse_mode: 'HTML', ...keyboard }).catch(() =>
      ctx.reply(welcome, { parse_mode: 'HTML', ...keyboard })
    );
  });

  bot.action('menu:search', async (ctx) => {
    await ctx.answerCbQuery();
    const prompt = '🔎 <b>Search the catalog</b>\n\nSend a video code or keyword in your next message.\n\nExamples: <code>ADN-001</code>, <code>STAR-765</code>';
    const options = { parse_mode: 'HTML' as const, ...Markup.inlineKeyboard([[Markup.button.callback('🏠 Home', 'menu:home')]]) };
    try {
      return await ctx.editMessageText(prompt, options);
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      return ctx.reply(prompt, options);
    }
  });

  bot.action('menu:help', async (ctx) => {
    await ctx.answerCbQuery();
    const helpText = [
      '❓ <b>PIRATECULTJAV HELP</b>',
      '',
      '🔎 <b>Search:</b> send a video code or keyword, or tap Search Catalog.',
      '🎬 <b>Website delivery:</b> tap Get Video on the website to open the matching video here.',
      '📊 <b>Account:</b> check your plan, daily allowance, and referrals.',
      '',
      '<b>Examples</b>',
      '<code>ADN-001</code>',
      '<code>STAR-765</code>',
      '',
      'Use the buttons below to navigate.'
    ].join('\n');
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🔎 Search Catalog', 'menu:search')],
      [Markup.button.callback('📊 My Account', 'user:plan'), Markup.button.callback('🏠 Home', 'menu:home')],
    ]);
    try {
      return await ctx.editMessageText(helpText, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      return ctx.reply(helpText, { parse_mode: 'HTML', ...keyboard });
    }
  });

  // 3. Cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.from) {
      await clearAdminSession(ctx.from.id);
    }
    return ctx.reply('Current operation canceled.');
  });

  // Advanced delivery analytics for administrators.
  bot.command('analytics', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const rawHours = Number(ctx.message.text.trim().split(/\s+/)[1] || '24');
    const hours = Number.isFinite(rawHours) ? Math.min(Math.max(Math.floor(rawHours), 1), 168) : 24;
    try {
      const stats = await getVideoDeliveryAnalytics(hours);
      const top = stats.topVideos.length ? stats.topVideos.map((item, index) => (index + 1) + '. <code>' + escapeHtml(item.code) + '</code> — ' + item.deliveries).join('\n') : 'No successful deliveries yet.';
      return ctx.reply('📊 <b>Delivery Analytics</b>\n\n⏱ Window: <b>' + hours + 'h</b>\n👥 Unique users: <b>' + stats.uniqueUsers + '</b>\n🎬 Attempts: <b>' + stats.attempts + '</b>\n✅ Delivered: <b>' + stats.delivered + '</b>\n🔒 Force-sub blocks: <b>' + stats.forceSubBlocks + '</b>\n🚫 Limit blocks: <b>' + stats.limitBlocks + '</b>\n⚠️ Delivery failures: <b>' + stats.failures + '</b>\n\n🔥 <b>Top delivered videos</b>\n' + top, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'analytics:24')], [Markup.button.callback('⬅️ Admin Center', 'settings:main')]]) });
    } catch (err) {
      console.error('[Analytics] Failed:', err);
      return ctx.reply('⚠️ Could not load delivery analytics.');
    }
  });
  // 4. Admin stats command
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized: Admin access required.');
    }

    const [userCount, videoCount, jobsCount] = await Promise.all([
      countUsers(),
      countVideos(),
      countJobs(),
    ]);

    const msg = [
      `📊 *PiratecultJAV Statistics*`,
      `\n👥 *Users:* \`${userCount}\``,
      `🎬 *Cataloged Videos:* \`${videoCount}\``,
      `\n⚙️ *Index Jobs Queue:*`,
      `• Queued: \`${jobsCount.queued}\``,
      `• Processing: \`${jobsCount.processing}\``,
      `• Completed: \`${jobsCount.completed}\``,
      `• Failed: \`${jobsCount.failed}\``,
      `• Total: \`${jobsCount.total}\``,
    ].join('\n');

    return ctx.replyWithMarkdown(msg);
  });

  async function showMissedCodes(ctx: any, requestedPage = 1, edit = false) {
    try {
      const pageSize = 20;
      const first = await listMissedCodes(pageSize, (requestedPage - 1) * pageSize);
      const pageCount = Math.max(1, Math.ceil(first.total / pageSize));
      const page = Math.min(Math.max(1, requestedPage), pageCount);
      const result = page === requestedPage ? first : await listMissedCodes(pageSize, (page - 1) * pageSize);
      const lines = [
        '🧾 <b>Codes Missing Metadata</b>',
        `📊 Total: <b>${result.total}</b> · Page <b>${page}/${pageCount}</b>`,
        '',
        ...(result.codes.length ? result.codes.map((item, index) =>
          `${(page - 1) * pageSize + index + 1}. <code>${escapeHtml(item.code)}</code> — ${escapeHtml(item.failure_reason || 'No metadata')}`
        ) : ['No missed codes recorded yet.']),
        '',
        'Tap a code button to add its title, thumbnail URL, and video manually.'
      ];
      const rows: any[] = result.codes.map(item => [
        Markup.button.callback('➕ Add ' + item.code.slice(0, 30), 'missedcodes:add:' + item.code.slice(0, 40))
      ]);
      const nav: any[] = [];
      if (page > 1) nav.push(Markup.button.callback('⬅️ Previous', 'missedcodes:page:' + (page - 1)));
      if (page < pageCount) nav.push(Markup.button.callback('Next ➡️', 'missedcodes:page:' + (page + 1)));
      if (nav.length) rows.push(nav);
      rows.push([Markup.button.callback('🔄 Refresh', 'missedcodes:page:' + page)]);
      const text = lines.join('\n');
      if (edit && ctx.callbackQuery) {
        try { return await ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }); }
        catch (err) {
          if (err instanceof Error && /message is not modified/i.test(err.message)) return;
        }
      }
      return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    } catch (err) {
      console.error('[MissedCodes] Failed to list:', err);
      return ctx.reply('❌ Could not load missed codes. Make sure Supabase migration 004_missed_metadata_codes.sql has been applied.');
    }
  }

  // 5. Admin /post workflow
  bot.command('post', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized: Admin access required.');
    }

    await setAdminSession(ctx.from.id, 'post', 'awaiting_code');
    return ctx.reply('📝 *Admin Post:* Please enter the JAV code to post (e.g. `ADN-001`):', {
      parse_mode: 'Markdown',
    });
  });

  bot.action('admin:missedcodes', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
    await ctx.answerCbQuery();
    return showMissedCodes(ctx, 1, true);
  });

  bot.command('missedcodes', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const requestedPage = Number(ctx.message.text.trim().split(/\s+/)[1] || '1');
    const page = Number.isInteger(requestedPage) ? Math.max(1, requestedPage) : 1;
    return showMissedCodes(ctx, page);
  });

  bot.action(/^missedcodes:page:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
    await ctx.answerCbQuery();
    return showMissedCodes(ctx, Math.max(1, Number(ctx.match[1]) || 1), true);
  });

  bot.action(/^missedcodes:add:([A-Z0-9_-]{1,40})$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
    const code = normalizeCode(ctx.match[1]);
    await ctx.answerCbQuery('Starting manual post…');
    await setAdminSession(ctx.from!.id, 'post', 'awaiting_manual_title', { code });
    return ctx.reply(`✍️ Enter the title for <code>${escapeHtml(code)}</code>, or /cancel to stop.`, { parse_mode: 'HTML' });
  });

  bot.command('payments', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    try {
      const payments = await listPremiumPayments(20);
      if (!payments.length) return ctx.reply('💳 No Premium payments recorded yet.');
      const lines = payments.map((p, i) =>
        `${i + 1}. 👤 <code>${p.telegram_user_id}</code> · 💎 ${p.duration_days}d · ⭐ ${p.amount_stars} · ${escapeHtml(new Date(p.created_at).toLocaleString())}`
      );
      return ctx.reply(
        '💳 <b>Recent Premium Payments</b>\n\n' + lines.join('\n'),
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Monetization', 'admin:monetization')]]) },
      );
    } catch (err) {
      console.error('[Payment] List failed:', err);
      return ctx.reply('❌ Could not load payment history.');
    }
  });

  bot.command('promos', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const pageArg = Number(ctx.message.text.trim().split(/\s+/)[1] || '1');
    const page = Number.isInteger(pageArg) ? Math.max(1, Math.min(pageArg, 1000)) : 1;
    try {
      const promos = await listPromoCodes(50);
      if (!promos.length) {
        return ctx.reply('🎟️ <b>No promo codes yet</b>\n\nUse the button below to create your first promo with a step-by-step wizard.', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('➕ Create Promo', 'promos:create_help')],
            [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
          ]),
        });
      }

      const pageSize = 10;
      const pageCount = Math.max(1, Math.ceil(promos.length / pageSize));
      const safePage = Math.min(page, pageCount);
      const pageItems = promos.slice((safePage - 1) * pageSize, safePage * pageSize);
      const now = Date.now();
      const lines = pageItems.map((p, i) => {
        const reward = p.reward_type === 'unlimited'
          ? `∞ Unlimited · ${p.reward_days}d`
          : `${p.reward_plan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} · ${p.reward_days}d`;
        const exhausted = p.max_uses !== null && p.used_count >= p.max_uses;
        const expired = Boolean(p.expires_at && new Date(p.expires_at).getTime() <= now);
        const status = !p.is_active ? '⛔ Disabled' : expired ? '⌛ Expired' : exhausted ? '🚫 Exhausted' : '🟢 Active';
        const usage = p.max_uses === null
          ? `${p.used_count}/∞ used`
          : `${p.used_count}/${p.max_uses} used · ${Math.max(0, p.max_uses - p.used_count)} left`;
        const expiry = p.expires_at ? new Date(p.expires_at).toLocaleString() : 'No expiry';
        return `${(safePage - 1) * pageSize + i + 1}. <code>${escapeHtml(p.code)}</code>\n   ${status} · ${reward}\n   👥 ${usage}\n   ⏰ ${escapeHtml(expiry)}`;
      });

      const active = promos.filter(p => p.is_active && (!p.expires_at || new Date(p.expires_at).getTime() > now) && (p.max_uses === null || p.used_count < p.max_uses)).length;
      const exhausted = promos.filter(p => p.max_uses !== null && p.used_count >= p.max_uses).length;
      const text = `🎟️ <b>Promo Manager</b>\nPage ${safePage}/${pageCount} · Showing ${pageItems.length} of latest ${promos.length}\n🟢 Available: ${active} · 🚫 Exhausted: ${exhausted}\n\n` + lines.join('\n\n');
      const rows = [];
      if (safePage > 1 || safePage < pageCount) {
        const nav = [];
        if (safePage > 1) nav.push(Markup.button.callback('⬅️ Previous', `promos:page:${safePage - 1}`));
        if (safePage < pageCount) nav.push(Markup.button.callback('Next ➡️', `promos:page:${safePage + 1}`));
        rows.push(nav);
      }
      rows.push([Markup.button.callback('➕ Create Promo', 'promos:create_help')]);
      rows.push([Markup.button.callback('⬅️ Admin Center', 'settings:main')]);
      return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    } catch (err) {
      console.error('[Promo] List failed:', err);
      return ctx.reply('❌ Could not load promo codes.');
    }
  });

  bot.action(/^promos:page:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const page = Math.max(1, Number(ctx.match[1]) || 1);
    // Re-run the command handler's rendering using the requested page.
    const promos = await listPromoCodes(50);
    if (!promos.length) return ctx.reply('🎟️ No promo codes found.');
    const pageSize = 10;
    const pageCount = Math.max(1, Math.ceil(promos.length / pageSize));
    const safePage = Math.min(page, pageCount);
    const pageItems = promos.slice((safePage - 1) * pageSize, safePage * pageSize);
    const now = Date.now();
    const lines = pageItems.map((p, i) => {
      const reward = p.reward_type === 'unlimited' ? `∞ Unlimited · ${p.reward_days}d` : `${p.reward_plan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} · ${p.reward_days}d`;
      const exhausted = p.max_uses !== null && p.used_count >= p.max_uses;
      const expired = Boolean(p.expires_at && new Date(p.expires_at).getTime() <= now);
      const status = !p.is_active ? '⛔ Disabled' : expired ? '⌛ Expired' : exhausted ? '🚫 Exhausted' : '🟢 Active';
      const usage = p.max_uses === null ? `${p.used_count}/∞ used` : `${p.used_count}/${p.max_uses} used · ${Math.max(0, p.max_uses - p.used_count)} left`;
      const expiry = p.expires_at ? new Date(p.expires_at).toLocaleString() : 'No expiry';
      return `${(safePage - 1) * pageSize + i + 1}. <code>${escapeHtml(p.code)}</code>\n   ${status} · ${reward}\n   👥 ${usage}\n   ⏰ ${escapeHtml(expiry)}`;
    });
    const active = promos.filter(p => p.is_active && (!p.expires_at || new Date(p.expires_at).getTime() > now) && (p.max_uses === null || p.used_count < p.max_uses)).length;
    const exhausted = promos.filter(p => p.max_uses !== null && p.used_count >= p.max_uses).length;
    const text = `🎟️ <b>Promo Manager</b>\nPage ${safePage}/${pageCount} · Showing ${pageItems.length} of latest ${promos.length}\n🟢 Available: ${active} · 🚫 Exhausted: ${exhausted}\n\n` + lines.join('\n\n');
    const rows: any[] = [];
    if (safePage > 1 || safePage < pageCount) {
      const nav = [];
      if (safePage > 1) nav.push(Markup.button.callback('⬅️ Previous', `promos:page:${safePage - 1}`));
      if (safePage < pageCount) nav.push(Markup.button.callback('Next ➡️', `promos:page:${safePage + 1}`));
      rows.push(nav);
    }
    rows.push([Markup.button.callback('➕ Create Promo', 'promos:create_help')]);
    rows.push([Markup.button.callback('⬅️ Admin Center', 'settings:main')]);
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() =>
      ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) })
    );
  });

  bot.action('promos:create_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    await setAdminSession(ctx.from!.id, 'promo_create', 'awaiting_code', {});
    return ctx.reply(
      '➕ <b>Create Promo — Step 1 of 5</b>\n\nEnter a promo code, or send <code>AUTO</code> to generate one.\n\nCode must be 3–64 characters using letters, numbers, hyphens, or underscores.\nSend /cancel to stop.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]) },
    );
  });

  bot.action('promos:wizard:uses:unlimited', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const session = await getAdminSession(ctx.from!.id);
    if (session?.action !== 'promo_create' || session.step !== 'awaiting_uses') {
      return ctx.answerCbQuery('This promo wizard expired. Start again.', { show_alert: true });
    }
    await ctx.answerCbQuery();
    await setAdminSession(ctx.from!.id, 'promo_create', 'awaiting_expiry', { ...(session.payload || {}), maxUses: null });
    return ctx.reply('➕ <b>Create Promo — Step 5 of 5</b>\n\nEnter an expiry date/time in ISO format, or choose no expiry.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('♾️ No Expiry', 'promos:wizard:expiry:none')], [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]),
    });
  });

  bot.action('promos:wizard:expiry:none', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const session = await getAdminSession(ctx.from!.id);
    if (session?.action !== 'promo_create' || session.step !== 'awaiting_expiry') {
      return ctx.answerCbQuery('This promo wizard expired. Start again.', { show_alert: true });
    }
    await ctx.answerCbQuery();
    const payload: Record<string, any> = { ...(session.payload || {}), expiresAt: null };
    await setAdminSession(ctx.from!.id, 'promo_create', 'awaiting_confirmation', payload);
    const rewardText = payload.reward === 'unlimited' ? 'Unlimited access' : payload.reward === 'premium' ? 'Premium' : 'Semi Premium';
    const codeText = payload.code === 'AUTO' ? 'Auto-generated on confirmation' : escapeHtml(String(payload.code || ''));
    return ctx.reply(
      `🧾 <b>Review Promo</b>\n\n🎟️ Code: <code>${codeText}</code>\n🎁 Reward: <b>${rewardText}</b>\n📅 Duration: <b>${payload.days} day(s)</b>\n👥 Max uses: <b>${payload.maxUses ?? 'Unlimited'}</b>\n⏰ Expiry: <b>No expiry</b>\n\nConfirm to create this promo.`,
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm & Create', 'promos:wizard:confirm')], [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]) },
    );
  });

  bot.action(/^promos:wizard:reward:(premium|semi_premium|unlimited)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const reward = ctx.match[1];
    const session = await getAdminSession(ctx.from!.id);
    if (session?.action !== 'promo_create' || session.step !== 'awaiting_reward') {
      return ctx.answerCbQuery('This promo wizard expired. Start again.', { show_alert: true });
    }
    await ctx.answerCbQuery();
    await setAdminSession(ctx.from!.id, 'promo_create', 'awaiting_days', { ...(session.payload || {}), reward });
    return ctx.reply('➕ <b>Create Promo — Step 3 of 5</b>\n\nHow many days should the reward last? Send a whole number from <code>1</code> to <code>3650</code>.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]),
    });
  });

  bot.action('promos:wizard:confirm', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const session = await getAdminSession(ctx.from!.id);
    if (session?.action !== 'promo_create' || session.step !== 'awaiting_confirmation') {
      return ctx.answerCbQuery('This promo confirmation expired. Start again.', { show_alert: true });
    }
    await ctx.answerCbQuery('Creating promo…');
    const payload = session.payload || {};
    const codeInput = String(payload.code || '');
    const code = codeInput === 'AUTO' ? `PC-${randomBytes(5).toString('hex').toUpperCase()}` : codeInput;
    const reward = String(payload.reward || '');
    const days = Number(payload.days);
    const maxUses = payload.maxUses === null ? null : Number(payload.maxUses);
    const expiresAt = payload.expiresAt ? String(payload.expiresAt) : null;
    const rewardType = reward === 'unlimited' ? 'unlimited' : 'plan';
    const rewardPlan = rewardType === 'plan' ? reward as 'premium' | 'semi_premium' : null;
    try {
      const ok = await createPromoCode(code, rewardType, rewardPlan, days, maxUses, expiresAt, ctx.from!.id);
      if (!ok) return ctx.reply('❌ Promo was not created. The code may already exist. Start again with Create Promo.');
      await clearAdminSession(ctx.from!.id);
      const rewardText = rewardType === 'unlimited' ? `∞ Unlimited access for ${days} day(s)` : `${rewardPlan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} for ${days} day(s)`;
      return ctx.reply(
        `✅ <b>Promo created</b>\n\n🎟️ Code: <code>${escapeHtml(code)}</code>\n🎁 Reward: <b>${rewardText}</b>\n👥 Uses: <b>${maxUses ?? 'Unlimited'}</b>\n⏰ Expiry: <b>${expiresAt ? escapeHtml(new Date(expiresAt).toLocaleString()) : 'No expiry'}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🎟️ View Promo Manager', 'promos:page:1')], [Markup.button.callback('➕ Create Another', 'promos:create_help')]]) },
      );
    } catch (err) {
      console.error('[Promo] Wizard create failed:', err);
      return ctx.reply('❌ Failed to create promo: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.action('promos:wizard:cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery('Cancelled');
    await clearAdminSession(ctx.from!.id);
    return ctx.reply('Promo creation cancelled.', { ...Markup.inlineKeyboard([[Markup.button.callback('🎟️ Promo Manager', 'promos:page:1')]]) });
  });
  bot.command('deactivatepromo', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const code = ctx.message.text.trim().split(/\s+/)[1]?.trim();
    if (!code) return ctx.reply('Usage: /deactivatepromo <CODE>');
    try {
      const ok = await setPromoCodeActive(code, false);
      return ctx.reply(ok ? `✅ Promo <code>${escapeHtml(code.toUpperCase())}</code> deactivated.` : '❌ Promo code not found.', { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[Promo] Deactivate failed:', err);
      return ctx.reply('❌ Could not deactivate promo code.');
    }
  });

  bot.command('activatepromo', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const code = ctx.message.text.trim().split(/\s+/)[1]?.trim();
    if (!code) return ctx.reply('Usage: /activatepromo <CODE>');
    try {
      const ok = await setPromoCodeActive(code, true);
      return ctx.reply(ok ? `✅ Promo <code>${escapeHtml(code.toUpperCase())}</code> activated.` : '❌ Promo code not found.', { parse_mode: 'HTML' });
    } catch (err) {
      console.error('[Promo] Activate failed:', err);
      return ctx.reply('❌ Could not activate promo code.');
    }
  });

  bot.command('createpromo', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');

    const parts = ctx.message.text.trim().split(/\s+/);
    const requestedCode = (parts[1] || '').trim().toUpperCase();
    const reward = (parts[2] || '').toLowerCase();
    const days = Number(parts[3]);
    const maxUsesRaw = parts[4];
    const expiryRaw = parts[5];

    if (!requestedCode || !['premium', 'semi_premium', 'unlimited'].includes(reward) ||
        !Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply(
        'Usage:\n/createpromo <CODE|AUTO> <premium|semi_premium|unlimited> <days:1-3650> [max_uses|-] [expiry_iso|-]\n\nExamples:\n/createpromo WELCOME30 premium 30 100\n/createpromo AUTO semi_premium 7 1\n/createpromo AUTO unlimited 3 - 2026-12-31T23:59:59Z'
      );
    }

    if (requestedCode !== 'AUTO' && !/^[A-Z0-9_-]{3,64}$/.test(requestedCode)) {
      return ctx.reply('❌ Code must be 3–64 characters using only A–Z, 0–9, underscore, or hyphen.');
    }

    const maxUses = maxUsesRaw && maxUsesRaw !== '-' ? Number(maxUsesRaw) : null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses <= 0 || maxUses > 1000000)) {
      return ctx.reply('❌ max_uses must be between 1 and 1,000,000, or use - for unlimited uses.');
    }

    let expiresAt: string | null = null;
    if (expiryRaw && expiryRaw !== '-') {
      const parsed = new Date(expiryRaw);
      if (Number.isNaN(parsed.getTime())) return ctx.reply('❌ Invalid expiry. Use ISO format, e.g. 2026-12-31T23:59:59Z.');
      if (parsed.getTime() <= Date.now()) return ctx.reply('❌ Expiry must be a future date and time.');
      expiresAt = parsed.toISOString();
    }

    const code = requestedCode === 'AUTO' ? `PC-${randomBytes(5).toString('hex').toUpperCase()}` : requestedCode;
    const rewardType = reward === 'unlimited' ? 'unlimited' : 'plan';
    const rewardPlan = rewardType === 'plan' ? reward as 'premium' | 'semi_premium' : null;

    try {
      const ok = await createPromoCode(code, rewardType, rewardPlan, days, maxUses, expiresAt, ctx.from!.id);
      if (!ok) return ctx.reply('❌ Promo was not created. The code may already exist or the reward settings were rejected.');
      const rewardText = rewardType === 'unlimited' ? `∞ Unlimited access for ${days} day(s)` : `${rewardPlan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} for ${days} day(s)`;
      return ctx.reply(
        `✅ <b>Promo created</b>\n\n🎟️ Code: <code>${escapeHtml(code)}</code>\n🎁 Reward: <b>${rewardText}</b>\n👥 Uses: <b>${maxUses ?? 'Unlimited'}</b>\n⏰ Expiry: <b>${expiresAt ? escapeHtml(new Date(expiresAt).toLocaleString()) : 'No expiry'}</b>\n\n<i>Share the code with eligible users. Each Telegram user can redeem it once.</i>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🎟️ View Promo Manager', 'promos:page:1')]]) },
      );
    } catch (err) {
      console.error('[Promo] Create failed:', err);
      return ctx.reply('❌ Failed to create promo code. Please check the database migration and try again.');
    }
  });

  bot.command('createpromos', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const parts = ctx.message.text.trim().split(/\s+/);
    const count = Number(parts[1]);
    const reward = (parts[2] || '').toLowerCase();
    const days = Number(parts[3]);
    const maxUsesRaw = parts[4];
    const expiryRaw = parts[5];

    if (!Number.isInteger(count) || count < 1 || count > 50 ||
        !['premium', 'semi_premium', 'unlimited'].includes(reward) ||
        !Number.isInteger(days) || days < 1 || days > 3650) {
      return ctx.reply('Usage:\n/createpromos <count:1-50> <premium|semi_premium|unlimited> <days:1-3650> [max_uses_per_code|-] [expiry_iso|-]\n\nExample: /createpromos 10 premium 30 1');
    }
    const maxUses = maxUsesRaw && maxUsesRaw !== '-' ? Number(maxUsesRaw) : null;
    if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
      return ctx.reply('❌ max_uses_per_code must be 1–1,000,000 or - for unlimited uses.');
    }
    let expiresAt: string | null = null;
    if (expiryRaw && expiryRaw !== '-') {
      const parsed = new Date(expiryRaw);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
        return ctx.reply('❌ Expiry must be a valid future date/time in ISO format.');
      }
      expiresAt = parsed.toISOString();
    }
    const rewardType = reward === 'unlimited' ? 'unlimited' : 'plan';
    const rewardPlan = rewardType === 'plan' ? reward as 'premium' | 'semi_premium' : null;
    const created: string[] = [];
    let failed = 0;
    for (let i = 0; i < count; i++) {
      const code = `PC-${randomBytes(6).toString('hex').toUpperCase()}`;
      try {
        if (await createPromoCode(code, rewardType, rewardPlan, days, maxUses, expiresAt, ctx.from!.id)) created.push(code);
        else failed++;
      } catch (err) {
        failed++;
        console.warn('[Promo] Batch creation failed for one code:', err instanceof Error ? err.message : String(err));
      }
    }
    const lines = created.map((code, i) => `${i + 1}. <code>${escapeHtml(code)}</code>`);
    const message = `🎟️ <b>Promo batch complete</b>\n\n✅ Created: <b>${created.length}/${count}</b>\n❌ Failed: <b>${failed}</b>\n🎁 Reward: <b>${rewardType === 'unlimited' ? 'Unlimited' : rewardPlan}</b> · ${days} day(s)\n👥 Uses per code: <b>${maxUses ?? 'Unlimited'}</b>${expiresAt ? `\n⏰ Expires: <b>${escapeHtml(new Date(expiresAt).toLocaleString())}</b>` : ''}\n\n${lines.join('\n')}`;
    return ctx.reply(message.slice(0, 4000), { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🎟️ View Promo Manager', 'promos:page:1')]]) });
  });
  bot.command('user', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const userId = Number(ctx.message.text.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(userId)) return ctx.reply('Usage: /user <telegram_user_id>');
    try {
      const dashboard = await getUserDashboard(userId);
      if (!dashboard) return ctx.reply('❌ User not found.');
      const plan = dashboard.plan === 'premium' ? '💎 Premium' : dashboard.plan === 'semi_premium' ? '⚡ Semi Premium' : '🆓 Free';
      const expiry = dashboard.plan_expires_at ? new Date(dashboard.plan_expires_at).toLocaleString() : '—';
      const bonus = dashboard.unlimited_until ? new Date(dashboard.unlimited_until).toLocaleString() : '—';
      return ctx.reply(
        '👤 <b>User Details</b>\n\n' +
        `🆔 ID: <code>${userId}</code>\n` +
        `⭐ Plan: <b>${plan}</b>\n` +
        `📅 Plan expiry: <b>${escapeHtml(expiry)}</b>\n` +
        `🎁 Unlimited bonus: <b>${escapeHtml(bonus)}</b>\n` +
        `🎬 Today: <b>${dashboard.daily_used}/${dashboard.daily_limit}</b>\n` +
        `🤝 Referrals: <b>${dashboard.completed_referral_count}/${dashboard.referral_count}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Admin Center', 'settings:main')]]) },
      );
    } catch (err) {
      return ctx.reply('❌ Could not load user: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('setquota', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const parts = ctx.message.text.trim().split(/\\s+/).slice(1);
    try {
      // Keep the original two-number command working, while also allowing one-plan edits.
      if (parts.length === 2 && /^\\d+$/.test(parts[0]) && /^\\d+$/.test(parts[1])) {
        const free = Number(parts[0]);
        const semiPremium = Number(parts[1]);
        if (![free, semiPremium].every(value => Number.isInteger(value) && value >= 0 && value <= 100000)) {
          return ctx.reply('Usage: /setquota <free_limit> <semi_premium_limit>\nExample: /setquota 20 40');
        }
        await setDownloadQuotaSettings({ free, semi_premium: semiPremium });
      } else if (parts.length === 2 && /^(free|semi_premium)$/i.test(parts[0]) && /^\\d+$/.test(parts[1])) {
        const plan = parts[0].toLowerCase() as 'free' | 'semi_premium';
        const value = Number(parts[1]);
        if (!Number.isInteger(value) || value < 0 || value > 100000) {
          return ctx.reply('Quota must be a whole number from 0 to 100000.');
        }
        const current = await getDownloadQuotaSettings();
        await setDownloadQuotaSettings({ ...current, [plan]: value });
      } else {
        return ctx.reply(
          'Usage:\n/setquota <free_limit> <semi_premium_limit>\n/setquota free <limit>\n/setquota semi_premium <limit>\n\nExample: /setquota 20 40',
        );
      }

      const saved = await getDownloadQuotaSettings();
      return ctx.reply(
        '✅ <b>Download quotas saved</b>\n\n' +
        `🆓 Free: <b>${saved.free}/day</b>\n` +
        `⚡ Semi Premium: <b>${saved.semi_premium}/day</b>\n` +
        '💎 Premium: <b>Unlimited</b>',
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[Quota] Update failed:', err);
      return ctx.reply('❌ Could not save quota settings: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('quota', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    return showQuotaPlanMenu(ctx);
  });

  bot.command('setplan', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const parts = ctx.message.text.trim().split(/\s+/);
    const userId = Number(parts[1]);
    const plan = parts[2] as 'free' | 'semi_premium' | 'premium';
    if (!Number.isSafeInteger(userId) || !['free', 'semi_premium', 'premium'].includes(plan)) {
      return ctx.reply('Usage: /setplan <telegram_user_id> <free|semi_premium|premium>');
    }
    const ok = await setUserPlan(userId, plan);
    return ctx.reply(ok ? `✅ User ${userId} set to ${plan}.` : '❌ User not found.');
  });

  bot.command('premium', async (ctx) => {
    return sendPremiumStore(ctx);
  });

  bot.command('premiumadmin', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    return showPremiumPackageManager(ctx);
  });

  bot.command('promo', async (ctx) => {
    if (!ctx.from) return;
    const parts = ctx.message.text.trim().split(/\s+/);
    const code = parts[1]?.trim();
    if (!code) return ctx.reply('🎟️ <b>Redeem a promo code</b>\n\nUse <code>/promo YOUR_CODE</code> to apply a code.\n\nCodes are case-insensitive and can be redeemed once per account.', { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Dashboard', 'user:plan')]]) });

    try {
      const result = await redeemPromoCode(ctx.from.id, code);
      if (!result.success) {
        return ctx.reply(`❌ ${escapeHtml(result.message)}`, { parse_mode: 'HTML' });
      }

      const reward = result.reward_type === 'unlimited'
        ? `∞ Unlimited access for ${result.reward_days} day(s)`
        : `${result.reward_plan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} for ${result.reward_days} day(s)`;

      return ctx.reply(
        `🎉 <b>Promo redeemed!</b>\n\n🎟️ Code: <code>${escapeHtml(code.toUpperCase())}</code>\n🎁 Reward: <b>${reward}</b>\n📅 Until: <b>${result.expires_at ? escapeHtml(new Date(result.expires_at).toLocaleString()) : 'active'}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Dashboard', 'user:plan')]]) },
      );
    } catch (err) {
      console.error('[Promo] Redemption failed:', err);
      return ctx.reply('⚠️ Could not redeem this promo code right now. Please try again later.');
    }
  });

  bot.command('plan', async (ctx) => {
    if (!ctx.from) return;
    return sendUserPlan(ctx);
  });

  bot.command('referral', async (ctx) => {
    if (!ctx.from) return;
    return sendReferralInfo(bot, ctx);
  });

  // 6. Admin user blocking commands
  bot.command('block', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized.');
    }

    const parts = ctx.message.text.split(' ');
    const targetId = parseInt(parts[1], 10);
    if (!targetId || isNaN(targetId)) {
      return ctx.reply('Usage: /block <telegram_user_id>');
    }

    await setUserBlocked(targetId, true);
    return ctx.reply(`User ${targetId} has been blocked.`);
  });

  bot.command('unblock', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized.');
    }

    const parts = ctx.message.text.split(' ');
    const targetId = parseInt(parts[1], 10);
    if (!targetId || isNaN(targetId)) {
      return ctx.reply('Usage: /unblock <telegram_user_id>');
    }

    await setUserBlocked(targetId, false);
    return ctx.reply(`User ${targetId} has been unblocked.`);
  });

  // 7. Admin broadcast command (web dashboard is the primary UI)
  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const text = ctx.message.text.replace(/^\/broadcast\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    const userIds = await getBroadcastUserIds();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      await Promise.all(batch.map(async (userId) => {
        try {
          await withTelegramRetry(() => bot.telegram.sendMessage(userId, text), { label: `broadcast:${userId}` });
          sent++;
        } catch (error) {
          const info = classifyTelegramError(error);
          if (info.kind === 'blocked') {
            try { await setUserBlocked(userId, true); } catch { /* keep broadcast running */ }
          }
          failed++;
        }
      }));
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    return ctx.reply(`📣 Broadcast finished.\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
  });

  bot.command('jobs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    try {
      const jobs = await getRecentJobs(undefined, 15);
      if (!jobs.length) return ctx.reply('⚙️ No index jobs found.');
      const lines = jobs.map(j => `#${j.id} · <code>${escapeHtml(j.code)}</code> · <b>${j.status}</b> · attempts ${j.attempts}${j.error ? '\n   ❌ ' + escapeHtml(j.error.slice(0, 120)) : ''}`);
      return ctx.reply('⚙️ <b>Recent Index Jobs</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err: unknown) {
      return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  bot.command('retryjob', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isInteger(id)) return ctx.reply('Usage: /retryjob <job_id>');
    try {
      const job = await retryJob(id);
      return ctx.reply(`🔄 Job #${job.id} for ${job.code} has been queued again.`);
    } catch (err: unknown) {
      return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  bot.command('test', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const code = normalizeCode(ctx.message.text.replace(/^\/test\s*/i, ''));
    if (!code) return ctx.reply('Usage: /test <JAV-CODE>');
    try {
      const metadata = await javtifulProvider.getMetadata(code);
      return ctx.reply(`🧪 <b>Javtiful Test</b>\n\n<b>Code:</b> <code>${escapeHtml(metadata.code)}</code>\n<b>Title:</b> ${escapeHtml(metadata.title)}\n<b>Actresses:</b> ${escapeHtml(metadata.actresses.join(', ') || 'N/A')}\n<b>Studio:</b> ${escapeHtml(metadata.studio || 'N/A')}\n<b>Duration:</b> ${escapeHtml(metadata.duration || 'N/A')}\n<b>Date:</b> ${escapeHtml(metadata.date || 'N/A')}\n<b>Genres:</b> ${escapeHtml(metadata.genres.join(', ') || 'N/A')}`, { parse_mode: 'HTML' });
    } catch (err: unknown) {
      return ctx.reply('❌ Provider test failed: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('addfs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const raw = ctx.message.text.replace(/^\/addfs\s*/i, '').trim();
    const parts = raw.split('|').map(v => v.trim());
    const channelId = parts[0];
    const requestMode = /^(true|yes|1)$/i.test((parts[1] || '').replace(/^request\s*:\s*/i, ''));
    if (!channelId) return ctx.reply('Usage: /addfs <channel_id> [| request:true|false]');
    try {
      const invite = await createForceSubInviteLink(bot, channelId, requestMode);
      const channel = await upsertForceSubChannel({
        channelId,
        title: invite.title,
        inviteLink: invite.inviteLink,
        requestMode,
        isActive: true,
      });
      return ctx.reply(
        `✅ <b>Force-sub channel added</b>\n\n📢 <b>${escapeHtml(channel.title)}</b>\n🆔 <code>${escapeHtml(channel.channel_id)}</code>\n🔗 <code>${escapeHtml(channel.invite_link || '')}</code>\n📨 Request mode: <b>${channel.request_mode ? 'ON' : 'OFF'}</b>\n\nYou can change request mode below.`,
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback(channel.request_mode ? '📨 Turn Request Mode OFF' : '📨 Turn Request Mode ON', `settings:forcesub:request:${channel.id}`)],
            [Markup.button.callback('⬅️ Force-sub Settings', 'settings:forcesub')],
          ]),
        },
      );
    } catch (err: unknown) {
      return ctx.reply('❌ Could not add channel. Make sure the bot is an administrator and can create invite links.\n\n' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('removefs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /removefs <channel_record_id>');
    try { await deleteForceSubChannel(id); return ctx.reply('✅ Force-sub channel removed.'); }
    catch (err: unknown) { return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err))); }
  });

  bot.command('help', async (ctx) => {
    return ctx.reply([
      '<b>Help</b>',
      '',
      'Send a code or keyword to search.',
      '',
      'Commands',
      '',
      '/start',
      '/help',
      '/plan',
      '/premium',
      '/promo &lt;CODE&gt;',
      '/referral',
      '/leaderboard'
    ].join('\n'), { parse_mode: 'HTML' });
  });

  // Admin command center
  bot.command('settings', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return showAdminSettings(ctx);
  });

  async function configureNotificationChannel(ctx: any, type: 'join' | 'notfound', channelId: string) {
    const key = type === 'join' ? 'notification_join_premium_channel' : 'notification_not_found_channel';
    try {
      const me = await ctx.telegram.getMe();
      const chat = await ctx.telegram.getChat(channelId);
      const member = await ctx.telegram.getChatMember(channelId, me.id);
      if (!['administrator', 'creator'].includes(member.status) ||
          (member.status === 'administrator' && 'can_post_messages' in member && member.can_post_messages === false)) {
        return ctx.reply('❌ The bot must be an administrator with permission to post in that channel.');
      }
      await setSetting(key, String(chat.id));
      await clearAdminSession(ctx.from.id);
      return ctx.reply('✅ <b>Destination saved</b>\n\n📡 Channel: <code>' + escapeHtml(chat.id) +
        '</code>\n\nSend a test notification to verify delivery.',
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('🧪 Send Test Notification', 'notifications:test:' + type)],
          [Markup.button.callback('⚙️ Notification Settings', 'settings:notifications')],
        ]) });
    } catch (err) {
      console.warn('[NotificationSettings] Channel validation failed:', err instanceof Error ? err.message : String(err));
      return ctx.reply('❌ Could not validate that channel. Check the ID, add the bot as an administrator with posting permission, and try again.');
    }
  }

  bot.command('setjoinchannel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const value = 'text' in ctx.message ? ctx.message.text.replace(/^\/setjoinchannel(?:@\w+)?\s*/i, '').trim() : '';
    if (value.toLowerCase() === 'off') {
      await setSetting('notification_join_premium_channel', '');
      return ctx.reply('🔕 User and Premium notifications disabled.');
    }
    if (!/^-?\\d+$/.test(value)) return ctx.reply('Usage: /setjoinchannel <channel_id> or /setjoinchannel off');
    return configureNotificationChannel(ctx, 'join', value);
  });

  bot.command('setnotfoundchannel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const value = 'text' in ctx.message ? ctx.message.text.replace(/^\/setnotfoundchannel(?:@\w+)?\s*/i, '').trim() : '';
    if (value.toLowerCase() === 'off') {
      await setSetting('notification_not_found_channel', '');
      return ctx.reply('🔕 Not-found notifications disabled.');
    }
    if (!/^-?\\d+$/.test(value)) return ctx.reply('Usage: /setnotfoundchannel <channel_id> or /setnotfoundchannel off');
    return configureNotificationChannel(ctx, 'notfound', value);
  });

  bot.command('notificationchannels', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return renderNotificationSettings(ctx, false);
  });

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:main', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminSettings(ctx);
  });

  bot.action('admin:overview', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminSettings(ctx);
  });
  async function renderNotificationSettings(ctx: any, edit = true) {
    const joinChannel = await getSetting<string>('notification_join_premium_channel', '');
    const notFoundChannel = await getSetting<string>('notification_not_found_channel', '');
    const status = (id: string) => id ? '🟢 <b>Configured</b> · <code>' + escapeHtml(id) + '</code>' : '⚪ <i>Not configured</i>';
    const text =
      '🔔 <b>NOTIFICATION CENTER</b>\n━━━━━━━━━━━━━━━━━━━━\n\n' +
      '👥 <b>User & Premium Alerts</b>\nNew users and premium purchases\n' + status(joinChannel) + '\n\n' +
      '🔎 <b>Not-Found Search Alerts</b>\nSearches with no matching video\n' + status(notFoundChannel) + '\n\n' +
      'Choose a notification type to configure it. The bot must be an administrator with permission to post.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('👥 Configure User Alerts', 'notifications:configure:join')],
      [Markup.button.callback('🔎 Configure Not-Found Alerts', 'notifications:configure:notfound')],
      [Markup.button.callback('📊 View Current Configuration', 'notifications:refresh')],
      [Markup.button.callback('❌ Close', 'notifications:close')],
      [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
    ]);
    if (edit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  async function notificationKey(type: string): Promise<string> {
    return type === 'join' ? 'notification_join_premium_channel' : 'notification_not_found_channel';
  }

  async function renderNotificationType(ctx: any, type: 'join' | 'notfound', edit = true) {
    const key = await notificationKey(type);
    const channel = await getSetting<string>(key, '');
    const title = type === 'join' ? '👥 USER & PREMIUM ALERTS' : '🔎 NOT-FOUND SEARCH ALERTS';
    const description = type === 'join'
      ? 'Receive alerts for new users and premium purchases.'
      : 'Receive alerts when a search returns no matching videos.';
    const text = title + '\n━━━━━━━━━━━━━━━━━━━━\n\n' + description +
      '\n\n📡 <b>Destination:</b> ' + escapeHtml(channel || 'Not configured') +
      '\n\nChoose how to configure this destination.\n\n💡 Add the bot as an administrator with permission to post messages.';
    const buttons: any[] = [
      [Markup.button.callback('🆔 Enter Channel ID', 'notifications:input:' + type)],
      [Markup.button.callback('🔗 Forward Channel Post', 'notifications:forward:' + type)],
    ];
    if (channel) {
      buttons.push([Markup.button.callback('🧪 Test Notification', 'notifications:test:' + type)]);
      buttons.push([Markup.button.callback('🔕 Disable Notifications', 'notifications:disable:' + type)]);
    }
    buttons.push([Markup.button.callback('↩️ Back to Notification Center', 'settings:notifications')]);
    const keyboard = Markup.inlineKeyboard(buttons);
    if (edit) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  bot.action('settings:notifications', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    await ctx.answerCbQuery();
    return renderNotificationSettings(ctx, true);
  });

  bot.action('notifications:refresh', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    await ctx.answerCbQuery('Configuration refreshed.');
    return renderNotificationSettings(ctx, true);
  });

  bot.action(/^notifications:configure:(join|notfound)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    await ctx.answerCbQuery();
    return renderNotificationType(ctx, ctx.match[1] as 'join' | 'notfound', true);
  });

  bot.action(/^notifications:input:(join|notfound)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    const type = ctx.match[1] as 'join' | 'notfound';
    await setAdminSession(ctx.from.id, 'notification_channel', 'awaiting_channel', { type });
    await ctx.answerCbQuery();
    return ctx.reply('🆔 <b>Set Destination Channel</b>\n\n' +
      (type === 'join' ? 'User & Premium Alerts' : 'Not-Found Search Alerts') +
      '\n\nSend the channel ID (for example <code>-1001234567890</code>), or forward a post from that channel.\n\n' +
      'Make sure the bot is an administrator with permission to post. Send /cancel to stop.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'notifications:cancel')]]) });
  });

  bot.action(/^notifications:forward:(join|notfound)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    const type = ctx.match[1] as 'join' | 'notfound';
    await setAdminSession(ctx.from.id, 'notification_channel', 'awaiting_channel', { type, expectForward: true });
    await ctx.answerCbQuery();
    return ctx.reply('🔗 <b>Forward a Channel Post</b>\n\nForward any post from the destination channel to this chat. Telegram must identify the original channel for this to work.\n\nSend /cancel to stop.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'notifications:cancel')]]) });
  });

  bot.action('notifications:cancel', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    await clearAdminSession(ctx.from.id);
    await ctx.answerCbQuery('Setup cancelled.');
    return renderNotificationSettings(ctx, false);
  });

  bot.action(/^notifications:disable:(join|notfound)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    const type = ctx.match[1] as 'join' | 'notfound';
    await ctx.answerCbQuery();
    return ctx.reply('⚠️ <b>Disable notifications?</b>\n\n' +
      (type === 'join' ? 'New-user and premium-purchase alerts' : 'Not-found search alerts') +
      ' will stop being sent.\n\nAre you sure?',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Confirm Disable', 'notifications:disableconfirm:' + type)],
        [Markup.button.callback('↩️ Cancel', 'notifications:configure:' + type)],
      ]) });
  });

  bot.action(/^notifications:disableconfirm:(join|notfound)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    const type = ctx.match[1] as 'join' | 'notfound';
    await setSetting(await notificationKey(type), '');
    await clearAdminSession(ctx.from.id);
    await ctx.answerCbQuery('Notifications disabled.');
    return renderNotificationType(ctx, type, false);
  });

  bot.action(/^notifications:test:(join|notfound)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    const type = ctx.match[1] as 'join' | 'notfound';
    const channel = await getSetting<string>(await notificationKey(type), '');
    if (!channel) return ctx.answerCbQuery('Configure a destination first.', { show_alert: true });
    try {
      const me = await ctx.telegram.getMe();
      const member = await ctx.telegram.getChatMember(channel, me.id);
      if (!['administrator', 'creator'].includes(member.status) ||
          (member.status === 'administrator' && 'can_post_messages' in member && member.can_post_messages === false)) {
        return ctx.answerCbQuery('The bot must be an administrator with permission to post.', { show_alert: true });
      }
      await ctx.telegram.sendMessage(channel, '🧪 <b>Test Notification</b>\n\n' +
        (type === 'join' ? 'User & Premium Alerts are configured correctly.' : 'Not-Found Search Alerts are configured correctly.') +
        '\n\n<i>This is a test message from PiratecultJAV.</i>', { parse_mode: 'HTML' });
      await ctx.answerCbQuery('Test notification sent.');
      return ctx.reply('✅ Test notification delivered to <code>' + escapeHtml(channel) + '</code>.', {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Settings', 'notifications:configure:' + type)]]),
      });
    } catch (err) {
      console.warn('[NotificationSettings] Test delivery failed:', err instanceof Error ? err.message : String(err));
      return ctx.answerCbQuery('Test failed. Check the channel ID and bot permissions.', { show_alert: true });
    }
  });

  bot.action('notifications:close', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.', { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => undefined);
  });

  bot.action('referral:dismiss', async (ctx) => {
    await ctx.answerCbQuery('No pressure 😎 Invite friends whenever you feel like it.');
    return ctx.deleteMessage().catch(() => undefined);
  });


  async function showQuotaPlanMenu(ctx: any, edit = false) {
    const q = await getDownloadQuotaSettings();
    const text =
      '📥 <b>Download Quotas</b>\n\n' +
      `🆓 Free: <b>${q.free}/day</b>\n` +
      `⚡ Semi Premium: <b>${q.semi_premium}/day</b>\n` +
      '💎 Premium: <b>Unlimited</b>\n\n' +
      'Select a plan to edit its quota.';
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('🆓 Free', 'admin:quota:plan:free')],
      [Markup.button.callback('⚡ Semi Premium', 'admin:quota:plan:semi_premium')],
      [Markup.button.callback('💎 Premium', 'admin:quota:plan:premium')],
      [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
    ]);
    if (edit && ctx.callbackQuery) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  }

  bot.action('admin:quota', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    try {
      return await showQuotaPlanMenu(ctx, true);
    } catch (err) {
      console.error('[Quota] Could not render quota menu:', err);
      return ctx.reply('❌ Could not load download quotas.');
    }
  });

  bot.action(/^admin:quota:plan:(free|semi_premium|premium)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    try {
      const plan = ctx.match[1] as 'free' | 'semi_premium' | 'premium';
      const q = await getDownloadQuotaSettings();
      const title = plan === 'free' ? '🆓 Free Plan' : plan === 'semi_premium' ? '⚡ Semi Premium Plan' : '💎 Premium Plan';
      const current = plan === 'free' ? q.free : plan === 'semi_premium' ? q.semi_premium : null;
      const body = plan === 'premium'
        ? `💎 <b>Premium Plan</b>\n\nQuota: <b>Unlimited</b>`
        : `${title}\n\nCurrent quota: <b>${current}/day</b>`;
      const rows: any[] = [];
      if (plan !== 'premium') rows.push([Markup.button.callback('✏️ Edit Quota', `admin:quota:edit:${plan}`)]);
      rows.push([Markup.button.callback('⬅️ All Plans', 'admin:quota')]);
      return await ctx.editMessageText(body, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    } catch (err) {
      console.error('[Quota] Could not open plan:', err);
      return ctx.reply('❌ Could not open that quota plan. Please try again.');
    }
  });

  bot.action(/^admin:quota:edit:(free|semi_premium)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    try {
      const plan = ctx.match[1] as 'free' | 'semi_premium';
      const q = await getDownloadQuotaSettings();
      const current = plan === 'free' ? q.free : q.semi_premium;
      const title = plan === 'free' ? '🆓 Free Plan' : '⚡ Semi Premium Plan';
      const values = [0, 10, 20, 30, 40, 50, 75, 100, 150, 200];
      const rows: any[] = [];
      for (let i = 0; i < values.length; i += 2) {
        rows.push(values.slice(i, i + 2).map(value =>
          Markup.button.callback(value === 0 ? '🚫 0/day' : `${value}/day`, `admin:quota:save:${plan}:${value}`)
        ));
      }
      rows.push([Markup.button.callback('⌨️ Custom Number', `admin:quota:custom:${plan}`)]);
      rows.push([Markup.button.callback('⬅️ Back', `admin:quota:plan:${plan}`)]);
      return await ctx.editMessageText(
        `✏️ <b>Edit ${title}</b>\n\nCurrent limit: <b>${current}/day</b>\n\nChoose a new limit or enter a custom number.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
      );
    } catch (err) {
      console.error('[Quota] Could not open quota editor:', err);
      return ctx.reply('❌ Could not open the quota editor. Please try again.');
    }
  });

  bot.action(/^admin:quota:save:(free|semi_premium):(\\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const plan = ctx.match[1] as 'free' | 'semi_premium';
    const value = Number(ctx.match[2]);
    if (!Number.isInteger(value) || value < 0 || value > 100000) return ctx.answerCbQuery('Invalid quota.');
    await ctx.answerCbQuery('Saving…');
    let saved: { free: number; semi_premium: number };
    try {
      const q = await getDownloadQuotaSettings();
      await setDownloadQuotaSettings({ ...q, [plan]: value });
      saved = await getDownloadQuotaSettings();
      if (saved[plan] !== value) throw new Error('The database did not return the new quota value.');
    } catch (err) {
      console.error('[Quota] Save button failed:', err);
      return ctx.reply('❌ Could not save quota: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }

    const label = plan === 'free' ? 'Free' : 'Semi Premium';
    try {
      return await ctx.editMessageText(
        `✅ <b>${label} quota saved</b>\n\nNew limit: <b>${value}/day</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('✏️ Edit Again', `admin:quota:edit:${plan}`)],
          [Markup.button.callback('📥 All Plans', 'admin:quota')],
        ]) },
      );
    } catch (err) {
      console.warn('[Quota] Saved, but could not edit confirmation message:', err);
      return ctx.reply(`✅ ${label} quota saved: ${value}/day.`, { ...Markup.inlineKeyboard([
        [Markup.button.callback('✏️ Edit Again', `admin:quota:edit:${plan}`)],
        [Markup.button.callback('📥 All Plans', 'admin:quota')],
      ]) });
    }
  });

  bot.action(/^admin:quota:custom:(free|semi_premium)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const plan = ctx.match[1] as 'free' | 'semi_premium';
    const label = plan === 'free' ? 'Free' : 'Semi Premium';
    try {
      await setAdminSession(ctx.from.id, 'quota', 'awaiting_value', { plan });
      return ctx.reply(
        `⌨️ <b>Custom ${label} quota</b>\n\nSend a whole number from <code>0</code> to <code>100000</code>.\nSend /cancel to cancel.`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin:quota:cancel_custom')]]) },
      );
    } catch (err) {
      console.error('[Quota] Could not start custom editor:', err);
      return ctx.reply('❌ Could not start custom quota editing. Please try again.');
    }
  });

  bot.action('admin:quota:cancel_custom', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery('Cancelled');
    await clearAdminSession(ctx.from.id);
    return showQuotaPlanMenu(ctx);
  });

  bot.action('admin:monetization', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const packages = await getPremiumPackages(true);
    const packageLines = packages.length
      ? packages.map(pkg => `${pkg.active ? '🟢' : '🔴'} ${escapeHtml(pkg.label)} · ${pkg.days}d · ${pkg.stars} ⭐`).join('\n')
      : 'No packages configured.';
    return ctx.editMessageText(
      '💰 <b>Monetization</b>\n\n<b>Premium packages</b>\n' + packageLines + '\n\n' +
      '🎟️ Promo codes: <code>/createpromo</code>\n' +
      '👤 Manual plan assignment: <code>/setplan</code>\n' +
      '📥 Daily quotas: <code>/setquota</code>.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('💎 Manage Premium Plans', 'admin:premium_packages')],
          [Markup.button.callback('🎟️ Promo Help', 'admin:promo_help'), Markup.button.callback('📋 Promo List', 'admin:promos')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  async function showPremiumPackageManager(ctx: any) {
    const packages = await getPremiumPackages(true);
    const lines = packages.length
      ? packages.map(pkg => `${pkg.active ? '🟢 Active' : '🔴 Disabled'} · <b>${escapeHtml(pkg.label)}</b> — ${pkg.days} days / ${pkg.stars} ⭐`).join('\n')
      : 'No packages configured.';
    const rows: any[] = [[Markup.button.callback('➕ Create Custom Package', 'admin:premium_package:add')]];
    for (const pkg of packages) {
      rows.push([
        Markup.button.callback(`✏️ Edit ${pkg.days}d`, `admin:premium_package:edit:${pkg.days}`),
        Markup.button.callback(pkg.active ? `🔴 Disable ${pkg.days}d` : `🟢 Enable ${pkg.days}d`, `admin:premium_package:toggle:${pkg.days}`),
      ]);
      rows.push([Markup.button.callback(`🗑️ Remove ${pkg.days}d`, `admin:premium_package:remove_confirm:${pkg.days}`)]);
    }
    rows.push([Markup.button.callback('⬅️ Monetization', 'admin:monetization')]);
    const text = '💎 <b>Premium Plan Manager</b>\n\nCreate custom durations and Stars prices, edit labels/prices, or enable/disable packages.\n\n' + lines + '\n\n<i>Customers only see active packages.</i>';
    if (ctx.callbackQuery) {
      return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) }).catch(() =>
        ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) })
      );
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  }

  bot.action('admin:premium_packages', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showPremiumPackageManager(ctx);
  });

  bot.action('admin:premium_package:add', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await setAdminSession(ctx.from!.id, 'premium_package', 'awaiting_create');
    await ctx.answerCbQuery();
    return ctx.reply('➕ <b>Create Premium package</b>\n\nSend: <code>DAYS STARS LABEL</code>\nExample: <code>14 90 14 Days</code>\n\nDays: 1–3650 · Stars: 1–1000000 · Label: up to 32 characters.\nUse /cancel to abort.', { parse_mode: 'HTML' });
  });

  bot.action(/^admin:premium_package:edit:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const days = Number(ctx.match[1]);
    const pkg = (await getPremiumPackages(true)).find(item => item.days === days);
    if (!pkg) return ctx.answerCbQuery('Package not found.', { show_alert: true });
    await setAdminSession(ctx.from!.id, 'premium_package', 'awaiting_edit', { previousDays: days });
    await ctx.answerCbQuery();
    return ctx.reply(`✏️ <b>Edit ${escapeHtml(pkg.label)}</b>\n\nSend: <code>NEW_DAYS STARS LABEL</code>\nCurrent: <code>${pkg.days} ${pkg.stars} ${escapeHtml(pkg.label)}</code>\nExample: <code>30 150 30 Days</code>\n\nUse /cancel to abort.`, { parse_mode: 'HTML' });
  });

  bot.action(/^admin:premium_package:toggle:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    try {
      const ok = await togglePremiumPackage(Number(ctx.match[1]));
      if (!ok) return ctx.answerCbQuery('Package not found.', { show_alert: true });
      await ctx.answerCbQuery('Package status updated.');
      return showPremiumPackageManager(ctx);
    } catch (err) {
      return ctx.answerCbQuery(err instanceof Error ? err.message : 'Could not update package.', { show_alert: true });
    }
  });

  bot.action(/^admin:premium_package:remove_confirm:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const days = Number(ctx.match[1]);
    const pkg = (await getPremiumPackages(true)).find(item => item.days === days);
    if (!pkg) return ctx.answerCbQuery('Package not found.', { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.editMessageText(`⚠️ <b>Remove Premium package?</b>\n\n${escapeHtml(pkg.label)} · ${pkg.days} days · ${pkg.stars} ⭐\n\nExisting payments are not changed, but new customers won't be able to select this package.`, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ Yes, remove', `admin:premium_package:remove:${days}`)],
        [Markup.button.callback('⬅️ Cancel', 'admin:premium_packages')],
      ]),
    });
  });

  bot.action(/^admin:premium_package:remove:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    try {
      const ok = await removePremiumPackage(Number(ctx.match[1]));
      await ctx.answerCbQuery(ok ? 'Package removed.' : 'Package not found.');
      return showPremiumPackageManager(ctx);
    } catch (err) {
      return ctx.answerCbQuery(err instanceof Error ? err.message : 'Could not remove package.', { show_alert: true });
    }
  });

  bot.action('admin:promos', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const promos = await listPromoCodes(20);
    const lines = promos.length
      ? promos.map((p, i) => {
          const reward = p.reward_type === 'unlimited' ? `∞ ${p.reward_days}d unlimited` : `${p.reward_plan} ${p.reward_days}d`;
          const usage = p.max_uses === null ? `${p.used_count}/∞` : `${p.used_count}/${p.max_uses}`;
          return `${i + 1}. <code>${escapeHtml(p.code)}</code> · ${p.is_active ? '🟢 Active' : '🔴 Off'} · ${reward} · ${usage}`;
        })
      : ['No promo codes.'];
    return ctx.editMessageText('🎟️ <b>Promo Codes</b>\n\n' + lines.join('\n') + '\n\nUse <code>/activatepromo CODE</code> or <code>/deactivatepromo CODE</code>.', {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:monetization')]]),
    });
  });

  bot.action('admin:promo_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🎟️ <b>Promo Management</b>\n\n' +
      '<code>/createpromo CODE premium 30 100</code>\n' +
      '<code>/createpromo CODE semi_premium 7</code>\n' +
      '<code>/createpromo CODE unlimited 1 50</code>\n\n' +
      'Optional expiry: add an ISO timestamp as the last argument.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:monetization')]]) },
    );
  });

  bot.action('admin:content', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const jobs = await countJobs();
    return ctx.editMessageText(
      '🎬 <b>Content & Indexing</b>\n\n' +
      'Use these tools to manage the catalog and indexing pipeline.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📝 Post Video', 'admin:post_help'), Markup.button.callback('🧪 Provider Test', 'admin:test_help')],
          [Markup.button.callback('⚙️ Jobs', 'admin:jobs')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  bot.action('admin:post_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '📝 <b>Post Video</b>\n\nUse <code>/post</code>, enter the JAV code, then send/forward the video.\n\nThe bot fetches metadata, stores the video in the dump channel, and creates/updates the catalog record.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')]]) },
    );
  });

  bot.action('admin:test_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🧪 <b>Provider Test</b>\n\nUse <code>/test JAV-CODE</code> to fetch and display provider metadata without publishing a video.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')]]) },
    );
  });

  bot.action('admin:jobs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const jobs = await getRecentJobs(undefined, 10);
    const statusIcon = (status: string) => {
      switch (status) {
        case 'completed': return '✅';
        case 'processing': return '🔄';
        case 'queued': return '⏳';
        case 'failed': return '❌';
        default: return '•';
      }
    };
    const lines = jobs.length
      ? jobs.map(j => `${statusIcon(j.status)} <b>#${j.id}</b>  <code>${escapeHtml(j.code)}</code>  <i>${escapeHtml(j.status)}</i>${j.error ? '\n   ❌ ' + escapeHtml(j.error.slice(0, 100)) : ''}`)
      : ['No recent jobs.'];
    const rows: any[] = [];
    for (const job of jobs) {
      if (job.status === 'failed') rows.push([Markup.button.callback(`🔄 Retry #${job.id}`, `admin:job:retry:${job.id}`)]);
    }
    rows.push([Markup.button.callback('🔄 Refresh', 'admin:jobs')]);
    rows.push([Markup.button.callback('⬅️ Back', 'admin:content')]);
    return ctx.editMessageText('⚙️ <b>Recent Jobs</b>\n\n' + lines.join('\n'), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(rows),
    });
  });


  // Interactive user management: search by Telegram ID, inspect status, and change plan/block state.
  bot.action('admin:users', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '👥 <b>User Management</b>\n\nSearch a Telegram user ID to view their plan, daily usage, referral activity, and account status.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Search User', 'admin:users:search')],
        [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
      ]) },
    );
  });

  bot.action('admin:users:search', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    await setAdminSession(ctx.from!.id, 'user_lookup', 'awaiting_id');
    return ctx.reply(
      '🔍 <b>Find User</b>\n\nSend the user’s numeric Telegram ID.\nExample: <code>123456789</code>\n\nSend /cancel to stop.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('❌ Cancel', 'admin:users:cancel')]]) },
    );
  });

  bot.action('admin:users:cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery('Cancelled');
    await clearAdminSession(ctx.from!.id);
    return ctx.editMessageText('👥 <b>User Management</b>\n\nSearch cancelled.', {
      parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Search User', 'admin:users:search')],
        [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
      ]),
    });
  });

  async function showAdminUserProfile(ctx: any, userId: number) {
    const [user, dashboard] = await Promise.all([getUser(userId), getUserDashboard(userId)]);
    if (!user || !dashboard) {
      const message = '❌ User not found. Check the Telegram ID and try again.';
      if (ctx.callbackQuery) return ctx.editMessageText(message, { ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Search Another User', 'admin:users:search')],
        [Markup.button.callback('⬅️ User Management', 'admin:users')],
      ]) });
      return ctx.reply(message, { ...Markup.inlineKeyboard([
        [Markup.button.callback('🔍 Search Another User', 'admin:users:search')],
        [Markup.button.callback('⬅️ User Management', 'admin:users')],
      ]) });
    }

    const planLabel = dashboard.plan === 'premium' ? '💎 Premium' : dashboard.plan === 'semi_premium' ? '⚡ Semi Premium' : '🆓 Free';
    const quota = dashboard.is_unlimited ? 'Unlimited' : String(dashboard.daily_limit);
    const remaining = dashboard.is_unlimited ? '∞' : String(dashboard.daily_remaining);
    const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || (user.username ? '@' + user.username : 'Unknown');
    const text = [
      '👤 <b>User Profile</b>',
      '',
      'Name: <b>' + escapeHtml(displayName) + '</b>',
      'Username: <b>' + escapeHtml(user.username ? '@' + user.username : '—') + '</b>',
      'ID: <code>' + userId + '</code>',
      'Status: <b>' + (user.is_blocked ? '🚫 Blocked' : '🟢 Active') + '</b>',
      'Plan: <b>' + planLabel + '</b>',
      'Daily usage: <b>' + dashboard.daily_used + '/' + quota + '</b>',
      'Remaining today: <b>' + remaining + '</b>',
      'Referrals: <b>' + dashboard.completed_referral_count + '/' + dashboard.referral_count + '</b>',
      dashboard.plan_expires_at ? 'Plan expires: <b>' + escapeHtml(new Date(dashboard.plan_expires_at).toLocaleString()) + '</b>' : '',
    ].filter(Boolean).join('\n');

    const rows: any[] = [
      [
        Markup.button.callback('🆓 Free', 'admin:user:plan:' + userId + ':free'),
        Markup.button.callback('⚡ Semi Premium', 'admin:user:plan:' + userId + ':semi_premium'),
      ],
      [Markup.button.callback('💎 Premium', 'admin:user:plan:' + userId + ':premium')],
      [Markup.button.callback(user.is_blocked ? '🟢 Unblock User' : '🚫 Block User', 'admin:user:block:' + userId + ':' + (user.is_blocked ? '0' : '1'))],
      [Markup.button.callback('🔍 Search Another User', 'admin:users:search')],
      [Markup.button.callback('⬅️ User Management', 'admin:users')],
    ];
    if (ctx.callbackQuery) return ctx.editMessageText(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
    return ctx.reply(text, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  }

  bot.action(/^admin:user:profile:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    try { return await showAdminUserProfile(ctx, Number(ctx.match[1])); }
    catch (err) { return ctx.reply('❌ Could not load user profile: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' }); }
  });

  bot.action(/^admin:user:plan:(\d+):(free|semi_premium|premium)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const userId = Number(ctx.match[1]);
    const plan = ctx.match[2] as 'free' | 'semi_premium' | 'premium';
    try {
      const ok = await setUserPlan(userId, plan);
      if (!ok) return ctx.answerCbQuery('User not found.', { show_alert: true });
      await ctx.answerCbQuery('Plan updated.');
      return showAdminUserProfile(ctx, userId);
    } catch (err) {
      return ctx.answerCbQuery('Could not update plan: ' + (err instanceof Error ? err.message : 'Unknown error'), { show_alert: true });
    }
  });

  bot.action(/^admin:user:block:(\d+):(0|1)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const userId = Number(ctx.match[1]);
    const shouldBlock = ctx.match[2] === '1';
    try {
      await setUserBlocked(userId, shouldBlock);
      await ctx.answerCbQuery(shouldBlock ? 'User blocked.' : 'User unblocked.');
      return showAdminUserProfile(ctx, userId);
    } catch (err) {
      return ctx.answerCbQuery('Could not update user status: ' + (err instanceof Error ? err.message : 'Unknown error'), { show_alert: true });
    }
  });

  bot.action(/^admin:job:retry:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const jobId = Number(ctx.match[1]);
    try {
      const job = await retryJob(jobId);
      await ctx.answerCbQuery('Job queued again.');
      return ctx.editMessageText('🔄 <b>Job queued again</b>\n\n#' + job.id + ' · <code>' + escapeHtml(job.code) + '</code>', {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([
          [Markup.button.callback('⚙️ View Jobs', 'admin:jobs')],
          [Markup.button.callback('⬅️ Admin Center', 'settings:main')],
        ]),
      });
    } catch (err) {
      return ctx.answerCbQuery('Retry failed: ' + (err instanceof Error ? err.message : 'Unknown error'), { show_alert: true });
    }
  });

  bot.action('admin:system', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🛠️ <b>System</b>\n\nChoose a system control:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🗑️ Delete Timer', 'settings:delete_timer')],
          [Markup.button.callback('🛠️ Maintenance', 'settings:maintenance')],
          [Markup.button.callback('🔄 Recovery', 'settings:recovery')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  bot.action('settings:delete_timer', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const seconds = await getSetting<number>('delete_timer_seconds', 0);
    return ctx.editMessageText('🗑️ *Auto-delete Timer*\n\nCurrent: *' + formatTimer(seconds) + '*\n\nChoose a timer:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏱ 10 seconds', 'settings:timer:10'), Markup.button.callback('⏱ 30 seconds', 'settings:timer:30')],
        [Markup.button.callback('⏱ 1 minute', 'settings:timer:60'), Markup.button.callback('⏱ 5 minutes', 'settings:timer:300')],
        [Markup.button.callback('⏱ 10 minutes', 'settings:timer:600'), Markup.button.callback('⏱ 30 minutes', 'settings:timer:1800')],
        [Markup.button.callback('⏱ 1 hour', 'settings:timer:3600'), Markup.button.callback('⏱ 24 hours', 'settings:timer:86400')],
        [Markup.button.callback('🔴 OFF', 'settings:timer:0')],
        [Markup.button.callback('⬅️ Back', 'settings:main')],
      ]),
    });
  });

  bot.action(/^settings:timer:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const seconds = Number.parseInt(ctx.match[1], 10);
    await setSetting('delete_timer_seconds', seconds);
    await ctx.answerCbQuery(seconds > 0 ? 'Timer updated.' : 'Timer disabled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    await setAdminSession(ctx.from.id, 'broadcast', 'awaiting_message');
    return ctx.editMessageText('📣 *Broadcast*\n\nSend the message to broadcast to all users.\n\nUse /cancel to abort.', { parse_mode: 'Markdown' });
  });


  bot.action('settings:broadcast:send', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const session = await getAdminSession(ctx.from!.id);
    const message = session?.action === 'broadcast' && session.step === 'awaiting_confirmation'
      ? String(session.payload?.message || '')
      : '';
    if (!message) return ctx.answerCbQuery('Broadcast preview expired. Start again.', { show_alert: true });
    await ctx.answerCbQuery('Broadcast started…');
    await clearAdminSession(ctx.from!.id);
    try {
      const userIds = await getBroadcastUserIds();
      let sent = 0, failed = 0;
      for (let i = 0; i < userIds.length; i += 25) {
        const batch = userIds.slice(i, i + 25);
        await Promise.all(batch.map(async (userId) => {
          try {
            await withTelegramRetry(() => bot.telegram.sendMessage(userId, message), { label: 'broadcast:' + userId });
            sent++;
          } catch (error) {
            failed++;
            if (classifyTelegramError(error).kind === 'blocked') {
              try { await setUserBlocked(userId, true); } catch { /* keep broadcast running */ }
            }
          }
        }));
        if (i + 25 < userIds.length) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      return ctx.editMessageText('📣 <b>Broadcast finished</b>\n\n👥 Recipients: <b>' + userIds.length + '</b>\n✅ Sent: <b>' + sent + '</b>\n❌ Failed: <b>' + failed + '</b>', {
        parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Admin Center', 'settings:main')]]),
      });
    } catch (err) {
      console.error('[Broadcast] Failed:', err);
      return ctx.editMessageText('❌ Broadcast failed while loading recipients. No further messages were sent.', {
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Admin Center', 'settings:main')]]),
      });
    }
  });

  bot.action('settings:broadcast:cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await clearAdminSession(ctx.from!.id);
    await ctx.answerCbQuery('Broadcast cancelled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:forcesub', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const enabled = await getSetting<boolean>('force_sub_enabled', false);
    return showForceSubAdminMenu(ctx);
  });

  bot.action(/^settings:forcesub:test:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });

    await ctx.answerCbQuery('Testing channel…');
    try {
      const me = await bot.telegram.getMe();
      const chat = await bot.telegram.getChat(channel.channel_id);
      const member = await bot.telegram.getChatMember(channel.channel_id, me.id);
      const isAdminInChannel = member.status === 'creator' || member.status === 'administrator';
      const status = member.status;
      const title = 'title' in chat ? String(chat.title || channel.title) : channel.title;
      const inviteState = channel.invite_link ? 'Saved' : 'Missing';
      const result = [
        '🧪 <b>Force-sub Channel Test</b>',
        '',
        '📢 <b>' + escapeHtml(title) + '</b>',
        '🆔 <code>' + escapeHtml(channel.channel_id) + '</code>',
        '',
        (isAdminInChannel ? '✅' : '❌') + ' Bot admin access: <b>' + (isAdminInChannel ? 'OK' : 'NOT ADMIN') + '</b>',
        '🤖 Bot status: <b>' + escapeHtml(status) + '</b>',
        (isAdminInChannel ? '✅' : '⚠️') + ' Membership verification: <b>' + (isAdminInChannel ? 'Ready to test users' : 'May fail until bot is admin') + '</b>',
        (channel.invite_link ? '✅' : '⚠️') + ' Saved invite link: <b>' + inviteState + '</b>',
        '🔒 Channel requirement: <b>' + (channel.is_active ? 'Active' : 'Disabled') + '</b>',
        '📨 Join-request mode: <b>' + (channel.request_mode ? 'ON' : 'OFF') + '</b>',
        '',
        isAdminInChannel
          ? 'The bot can access this channel. Membership checks should work when the bot has the required channel permissions.'
          : 'Add the bot as a channel administrator, then run this test again.',
      ].join('\n');
      return ctx.editMessageText(result, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Test Again', 'settings:forcesub:test:' + channel.id)],
          [Markup.button.callback('⬅️ Force-sub Settings', 'settings:forcesub')],
        ]),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const message = [
        '🧪 <b>Force-sub Channel Test</b>',
        '',
        '📢 <b>' + escapeHtml(channel.title) + '</b>',
        '🆔 <code>' + escapeHtml(channel.channel_id) + '</code>',
        '',
        '❌ Could not access or inspect this channel.',
        '',
        '<b>Telegram error:</b> ' + escapeHtml(detail.slice(0, 500)),
        '',
        'Check the channel ID and ensure the bot is added to the channel as an administrator.',
      ].join('\n');
      return ctx.editMessageText(message, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Test Again', 'settings:forcesub:test:' + channel.id)], [Markup.button.callback('⬅️ Force-sub Settings', 'settings:forcesub')]]),
      });
    }
  });

  bot.action('settings:forcesub:add', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await setAdminSession(ctx.from.id, 'force_sub_add', 'awaiting_channel');
    await ctx.answerCbQuery();
    return ctx.reply(
      '➕ <b>Add Force-Sub Channel</b>\n\n' +
      'Add the bot as an administrator in the channel first.\n\n' +
      'Then send:\n<code>channel_id</code>\n\n' +
      'Optional request mode:\n<code>channel_id | request:true</code>\n<code>channel_id | request:false</code>\n\n' +
      'The bot will automatically read the channel title and create the correct invite link.',
      { parse_mode: 'HTML' },
    );
  });

  bot.action(/^settings:forcesub:toggle-channel:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });
    await updateForceSubChannel(channel.id, { is_active: !channel.is_active });
    await ctx.answerCbQuery(channel.is_active ? 'Disabled.' : 'Enabled.');
    return showForceSubAdminMenu(ctx);
  });

  bot.action(/^settings:forcesub:request:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });

    const nextMode = !channel.request_mode;
    try {
      // Regenerate the invite so the link itself matches the selected join mode.
      const invite = await createForceSubInviteLink(bot, channel.channel_id, nextMode);
      await updateForceSubChannel(channel.id, {
        request_mode: nextMode,
        invite_link: invite.inviteLink,
        title: invite.title,
      });
      await ctx.answerCbQuery(nextMode ? 'Request mode enabled.' : 'Request mode disabled.');
      return showForceSubAdminMenu(ctx);
    } catch (err: unknown) {
      return ctx.answerCbQuery(
        'Could not update invite. Check bot admin permissions.',
        { show_alert: true },
      );
    }
  });

  bot.action(/^settings:forcesub:confirm-delete:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '⚠️ <b>Delete force-sub channel?</b>\n\n📢 <b>' + escapeHtml(channel.title) + '</b>\n🆔 <code>' + escapeHtml(channel.channel_id) + '</code>\n\nThis removes it from the subscription requirements. This action cannot be undone.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🗑️ Yes, delete channel', 'settings:forcesub:delete:' + channel.id)],
        [Markup.button.callback('↩️ Cancel', 'settings:forcesub')],
      ]) },
    );
  });

  bot.action(/^settings:forcesub:delete:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    try {
      await deleteForceSubChannel(ctx.match[1]);
      await ctx.answerCbQuery('Channel deleted.');
      return showForceSubAdminMenu(ctx);
    } catch {
      return ctx.answerCbQuery('Could not delete channel.', { show_alert: true });
    }
  });

  bot.action('settings:forcesub:toggle', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const current = await getSetting<boolean>('force_sub_enabled', false);
    await setSetting('force_sub_enabled', !current);
    await ctx.answerCbQuery(!current ? 'Force-sub enabled.' : 'Force-sub disabled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:maintenance', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const enabled = await getSetting<boolean>('maintenance_mode', false);
    return ctx.editMessageText('🛠️ *Maintenance Mode*\n\nStatus: *' + (enabled ? 'ENABLED' : 'DISABLED') + '*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(enabled ? '🟢 Turn Off' : '🔴 Turn On', 'settings:maintenance:toggle')],
        [Markup.button.callback('⬅️ Back', 'settings:main')],
      ]),
    });
  });

  bot.action('settings:maintenance:toggle', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const current = await getSetting<boolean>('maintenance_mode', false);
    await setSetting('maintenance_mode', !current);
    await ctx.answerCbQuery(!current ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
    return showAdminSettings(ctx);
  });

  bot.action(/^analytics:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const hours = Math.min(Math.max(Number.parseInt(ctx.match[1], 10) || 24, 1), 168);
    await ctx.answerCbQuery();
    try {
      const stats = await getVideoDeliveryAnalytics(hours);
      const top = stats.topVideos.length ? stats.topVideos.map((item, index) => (index + 1) + '. <code>' + escapeHtml(item.code) + '</code> — ' + item.deliveries).join('\n') : 'No successful deliveries yet.';
      return ctx.editMessageText('📊 <b>Delivery Analytics</b>\n\n⏱ Window: <b>' + hours + 'h</b>\n👥 Unique users: <b>' + stats.uniqueUsers + '</b>\n🎬 Attempts: <b>' + stats.attempts + '</b>\n✅ Delivered: <b>' + stats.delivered + '</b>\n🔒 Force-sub blocks: <b>' + stats.forceSubBlocks + '</b>\n🚫 Limit blocks: <b>' + stats.limitBlocks + '</b>\n⚠️ Delivery failures: <b>' + stats.failures + '</b>\n\n🔥 <b>Top delivered videos</b>\n' + top, { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'analytics:' + hours)], [Markup.button.callback('⬅️ Admin Center', 'settings:main')]]) });
    } catch { return ctx.answerCbQuery('Analytics unavailable.', { show_alert: true }); }
  });
  bot.action('settings:stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const [userCount, videoCount, jobs] = await Promise.all([countUsers(), countVideos(), countJobs()]);
    return ctx.editMessageText('📊 *Statistics*\n\n👥 Users: *' + userCount + '*\n🎬 Videos: *' + videoCount + '*\n\n⚙️ Jobs\n• Queued: ' + jobs.queued + '\n• Processing: ' + jobs.processing + '\n• Completed: ' + jobs.completed + '\n• Failed: ' + jobs.failed + '\n• Total: ' + jobs.total, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'settings:stats')], [Markup.button.callback('⬅️ Back', 'settings:main')]]),
    });
  });

  bot.action('settings:system', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const deleteTimer = await getSetting<number>('delete_timer_seconds', 0);
    const forceSub = await getSetting<boolean>('force_sub_enabled', false);
    const maintenance = await getSetting<boolean>('maintenance_mode', false);
    return ctx.editMessageText('🔧 *System Settings*\n\n🗑️ Delete timer: ' + formatTimer(deleteTimer) + '\n🔒 Force-sub: ' + (forceSub ? 'ON' : 'OFF') + '\n🛠️ Maintenance: ' + (maintenance ? 'ON' : 'OFF'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings:main')]]),
    });
  });

  bot.action('settings:recovery', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const primary = Boolean(config.botToken);
    const backup = Boolean(config.backupBotToken);
    const active = getStoredActiveBotRole() === 'primary' ? 'PRIMARY' : 'BACKUP';
    return ctx.editMessageText(
      '🔄 *Bot Recovery*\n\n' +
      '🟢 Active: *' + active + '*\n' +
      'Primary token: *' + (primary ? 'configured' : 'missing') + '*\n' +
      'Backup token: *' + (backup ? 'configured' : 'missing') + '*\n\n' +
      'The backup bot must be added to the same dump and force-sub channels with the required permissions.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟢 Use Primary', 'settings:recovery:primary')],
          [Markup.button.callback('🟢 Use Backup', 'settings:recovery:backup')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      }
    );
  });

  bot.action(/^settings:recovery:(primary|backup)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const role = ctx.match[1] as 'primary' | 'backup';
    if (!tokenForRole(role)) return ctx.answerCbQuery(`${role === 'primary' ? 'Primary' : 'Backup'} token is not configured.`);
    await ctx.answerCbQuery('Switching bot...');
    stopBotPolling();
    botInstance = null;
    setActiveBotRole(role);
    setActiveBotRole(role);
    const started = await startBotPolling();
    if (!started) {
      return ctx.reply('❌ Could not start the selected bot. Check its token and Telegram channel permissions.');
    }
    return showAdminSettings(ctx);
  });

  bot.action('settings:close', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => undefined);
  });
  bot.action('downloadall:confirm', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    const messageText = ctx.callbackQuery && 'message' in ctx.callbackQuery && !!ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.text
      : '';
    const match = messageText.match(/Search Results for:\s*([^\n]+)/i);
    if (!match) {
      await ctx.answerCbQuery('Search query not found. Please search again.', { show_alert: true });
      return;
    }
    const query = match[1].trim();
    const totalMatch = messageText.match(/Found:\s*(\d+)/i);
    const total = totalMatch ? Number(totalMatch[1]) : 0;
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '⬇️ <b>Confirm Download All</b>\n\n🔎 Search: <code>' + escapeHtml(query) + '</code>\n📚 Matching videos: <b>' + total + '</b>\n\nThis sends matching videos to this chat one by one. Each video counts toward your daily allowance, and large searches may take time. Continue?',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Yes, Download All', 'downloadall:run')],
          [Markup.button.callback('❌ Cancel', 'downloadall:cancel')],
        ]),
      },
    );
  });

  bot.action('downloadall:run', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    const messageText = ctx.callbackQuery && 'message' in ctx.callbackQuery && !!ctx.callbackQuery.message && 'text' in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.text
      : '';
    const match = messageText.match(/Search:\s*([^\n]+)/i);
    if (!match) {
      await ctx.answerCbQuery('Search query not found. Please search again.', { show_alert: true });
      return;
    }
    const query = match[1].trim();
    await ctx.answerCbQuery('Starting bulk delivery…');
    await ctx.editMessageText(
      '⏳ <b>Download All started</b>\n\n🔎 Search: <code>' + escapeHtml(query) + '</code>\nYour matching videos will be sent one by one. Keep this chat open.',
      { parse_mode: 'HTML' },
    );
    return downloadAllSearchResults(bot, ctx, query);
  });

  bot.action('downloadall:cancel', async (ctx) => {
    await ctx.answerCbQuery('Canceled.');
    return ctx.editMessageText(
      '❌ <b>Download All canceled.</b>\n\nUse Search Catalog to run another search.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🔎 Search Catalog', 'menu:search')], [Markup.button.callback('🏠 Home', 'menu:home')]]) },
    );
  });

  // 8. Video download callback query
  bot.action(/^download:(.+)$/, async (ctx) => {
    const identifier = ctx.match[1];
    await ctx.answerCbQuery('Fetching video...');
    return deliverVideoToUser(bot, ctx, identifier);
  });

  bot.action('premium:store', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendPremiumStore(ctx);
  });

  bot.action(/^premium:buy:(\d+)$/, async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendPremiumInvoice(ctx, Number(ctx.match[1]));
  });

  bot.action('user:promo', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    const text = '🎟️ <b>Redeem Promo</b>\n\nUse <code>/promo YOUR_CODE</code> to redeem a promo code.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ My Dashboard', 'user:plan')]]);
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  });

  bot.action('user:leaderboard', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendReferralLeaderboard(ctx);
  });

  bot.action('user:plan', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendUserPlan(ctx);
  });

  bot.action('user:referral', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendReferralInfo(bot, ctx);
  });

  // Admin video management callbacks
  bot.action(/^admin:vid:edit:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminVideoEditMenu(ctx, ctx.match[1]);
  });

  bot.action(/^admin:vid:refresh:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.answerCbQuery('Video not found.', { show_alert: true });

    await ctx.answerCbQuery('Refreshing metadata...');
    try {
      const metadata = await javtifulProvider.getMetadata(video.code);
      const updated = await updateVideoMetadata(video.id, {
        title: metadata.title,
        description: metadata.description,
        duration: metadata.duration,
        date: metadata.date,
        actresses: metadata.actresses,
        studio: metadata.studio,
        genres: metadata.genres,
      });

      await showAdminVideoEditMenu(ctx, updated.id);
      return ctx.reply(
        `✅ Metadata refreshed for <code>${escapeHtml(updated.code)}</code>.\nThe record now uses fresh Javtiful data.`,
        { parse_mode: 'HTML' },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return ctx.reply(
        `❌ Could not refresh <code>${escapeHtml(video.code)}</code>.\n${escapeHtml(message)}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.action(/^admin:vid:toggle_status:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.answerCbQuery('Video not found.');
    const nextStatus = video.status === 'available' ? 'disabled' : 'available';
    await updateVideoStatus(videoId, nextStatus);
    await ctx.answerCbQuery(`Status set to ${nextStatus}.`);
    return showAdminVideoEditMenu(ctx, videoId);
  });

  bot.action(/^admin:vid:set:(title|actresses|studio|duration):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const videoId = ctx.match[2];
    const video = await getVideoById(videoId);
    if (!video) return ctx.reply('Video not found.');

    await setAdminSession(ctx.from!.id, 'edit_video', field, { videoId: video.id, code: video.code });

    let prompt = '';
    if (field === 'title') {
      prompt = `📝 <b>Send the new title for</b> <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'actresses') {
      prompt = `💃 <b>Send actress name(s) separated by commas</b> for <code>${escapeHtml(video.code)}</code>:\n<i>Example: Meguri, Ootsuki Hibiki</i>\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'studio') {
      prompt = `🏢 <b>Send the studio/maker name for</b> <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'duration') {
      prompt = `⏱ <b>Send video duration</b> (e.g. <code>02:15:30</code>) for <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    }

    return ctx.reply(prompt, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', `admin:vid:edit:${videoId}`)]]),
    });
  });

  bot.action(/^admin:vid:del_confirm:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.reply('Video not found.');

    const prompt = [
      `⚠️ <b>Delete Video Confirmation</b>`,
      ``,
      `Are you sure you want to delete this video?`,
      `🏷️ <b>Code:</b> <code>${escapeHtml(video.code)}</code>`,
      `📌 <b>Title:</b> <i>${escapeHtml(video.title)}</i>`,
      ``,
      `🚨 <i>This will permanently remove it from catalog and search!</i>`,
    ].join('\n');

    return ctx.editMessageText(prompt, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Yes, Delete Video', `admin:vid:del_exec:${video.id}`)],
        [Markup.button.callback('⬅️ Cancel', `admin:vid:edit:${video.id}`)],
      ]),
    }).catch(() => {
      return ctx.reply(prompt, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔴 Yes, Delete Video', `admin:vid:del_exec:${video.id}`)],
          [Markup.button.callback('⬅️ Cancel', `admin:vid:edit:${video.id}`)],
        ]),
      });
    });
  });

  bot.action(/^admin:vid:del_exec:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    const code = video?.code || videoId;

    try {
      await deleteVideo(videoId);
      await ctx.answerCbQuery('Deleted.');
      return ctx.editMessageText(`🗑️ <b>Deleted:</b> Video <code>${escapeHtml(code)}</code> has been deleted from catalog.`, {
        parse_mode: 'HTML',
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return ctx.reply(`❌ Delete failed: ${errMsg}`);
    }
  });

  bot.action('admin:vid:cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery('Closed.');
    return ctx.deleteMessage().catch(() => undefined);
  });

  // 9. Force-sub membership recheck
  bot.action('check_sub', async (ctx) => {
    await ctx.answerCbQuery('Checking membership...');
    if (!ctx.from) return;

    const forceSub = await checkUserForceSub(bot, ctx.from.id);
    if (forceSub.passed) {
      return ctx.reply('✅ Membership verified. You can now search for videos.');
    }

    const buttons: any[] = forceSub.missingChannels.map(ch =>
      Markup.button.url(
        ch.request_mode ? `📨 Request to Join ${ch.title}` : `Join ${ch.title}`,
        ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`
      )
    );
    buttons.push(Markup.button.callback('🔄 Check Again', 'check_sub'));

    return ctx.reply(
      '⚠️ You still need to join the required channel(s).',
      Markup.inlineKeyboard(buttons.map(b => [b]))
    );
  });

  // 10. Pagination callback query for search results
  bot.action(/^search:(.+):(\d+)$/, async (ctx) => {
    const query = ctx.match[1];
    const page = parseInt(ctx.match[2], 10) || 0;
    await ctx.answerCbQuery();

    await handleSearchQuery(ctx, query, page);
  });

  // 11. Private screenshot channel + video dump channel listeners.
  // Telegram albums arrive as separate channel_post updates. Buffer each media group
  // briefly so every photo can inherit the album's video code if its own caption is
  // missing or formatted in a way the code extractor doesn't recognize.
  const screenshotAlbums = new Map<string, {
    chatId: string;
    code: string | null;
    photos: Array<{ messageId: number; fileId: string; width: number; height: number }>;
    timer: ReturnType<typeof setTimeout>;
  }>();

  async function saveScreenshotAlbum(key: string): Promise<void> {
    const album = screenshotAlbums.get(key);
    if (!album) return;
    screenshotAlbums.delete(key);
    if (!album.code) {
      console.warn(`[Screenshot] Ignored album ${key}: no recognizable video code in any caption.`);
      return;
    }
    try {
      const { saveScreenshotImage } = await import('../services/screenshotImages.ts');
      for (const photo of album.photos) {
        await saveScreenshotImage({
          code: album.code,
          normalizedCode: normalizeCode(album.code) || album.code,
          channelId: album.chatId,
          messageId: photo.messageId,
          fileId: photo.fileId,
          width: photo.width,
          height: photo.height,
        });
        console.log(`[Screenshot] Indexed image #${photo.messageId} for ${album.code}.`);
      }
    } catch (err) {
      console.error(`[Screenshot] Failed to index album ${key}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Webhook mode subscribes to channel_post updates below; polling receives them automatically.
  bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    const chatId = String(ctx.chat.id).trim();
    const configuredScreenshotChatId = String(config.screenshotChatId || '').trim();

    if (configuredScreenshotChatId && chatId === configuredScreenshotChatId) {
      if (!('photo' in post) || !post.photo?.length) return;
      const caption = String(('caption' in post ? post.caption : '') || '').trim();
      const codes = extractCodes(caption);
      const photo = post.photo[post.photo.length - 1];
      const mediaGroupId = 'media_group_id' in post ? post.media_group_id : undefined;

      if (mediaGroupId) {
        const key = `${chatId}:${mediaGroupId}`;
        let album = screenshotAlbums.get(key);
        if (!album) {
          const timer = setTimeout(() => { void saveScreenshotAlbum(key); }, 2000);
          album = { chatId, code: null, photos: [], timer };
          screenshotAlbums.set(key, album);
        } else {
          clearTimeout(album.timer);
          album.timer = setTimeout(() => { void saveScreenshotAlbum(key); }, 2000);
        }
        if (codes.length === 1) album.code = codes[0];
        else if (codes.length > 1) console.warn(`[Screenshot] Album ${key} has a caption with multiple video codes; using a valid code from another album caption if available.`);
        album.photos.push({
          messageId: post.message_id,
          fileId: photo.file_id,
          width: photo.width,
          height: photo.height,
        });
        return;
      }

      if (codes.length !== 1) {
        console.warn(`[Screenshot] Ignored photo #${post.message_id}: caption must contain exactly one video code.`);
        return;
      }

      try {
        const { saveScreenshotImage } = await import('../services/screenshotImages.ts');
        await saveScreenshotImage({
          code: codes[0],
          normalizedCode: normalizeCode(codes[0]) || codes[0],
          channelId: chatId,
          messageId: post.message_id,
          fileId: photo.file_id,
          width: photo.width,
          height: photo.height,
        });
        console.log(`[Screenshot] Indexed image #${post.message_id} for ${codes[0]}.`);
      } catch (err) {
        console.error(`[Screenshot] Failed to index photo #${post.message_id}:`, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    const configuredDumpChatId = String(config.dumpChatId || '').trim();
    if (configuredDumpChatId && chatId !== configuredDumpChatId) {
      return;
    }

    const hasMedia = 'video' in post || 'document' in post || 'animation' in post;
    if (!hasMedia) return;

    const caption = String(('caption' in post ? post.caption : ('text' in post ? post.text : '')) || '');
    if (!caption.trim()) {
      console.warn(`[DumpPost] Ignored media message #${post.message_id} in ${chatId}: caption is empty, so no video code can be detected.`);
      return;
    }

    const codes = extractCodes(caption);
    if (codes.length === 0) {
      console.warn(`[DumpPost] Ignored media message #${post.message_id} in ${chatId}: no video code found in caption.`);
      return;
    }

    const primaryCode = codes[0];
    const messageId = post.message_id;
    console.log(`[DumpPost] Detected media message #${messageId} in ${chatId} with code ${primaryCode}`);

    try {
      const result = await createIndexJob({
        code: primaryCode,
        dumpChatId: chatId,
        videoMessageId: messageId,
      });

      if (result.created) {
        console.log(`[DumpPost] Successfully queued index job #${result.job.id} for ${primaryCode}`);
      } else {
        console.log(`[DumpPost] Skipped duplicate media: ${result.reason}`);
      }
    } catch (err) {
      console.error(`[DumpPost] Failed to queue message #${messageId} (${primaryCode}):`, err instanceof Error ? err.message : String(err));
    }
  });

  // 12. Admin session handler for incoming text/video
  bot.on('message', async (ctx, next) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      return next();
    }

    const session = await getAdminSession(ctx.from.id);
    if (!session) {
      return next();
    }

    if (session.action === 'notification_channel') {
      if ('text' in ctx.message && ctx.message.text.trim() === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('❌ Notification setup cancelled.');
      }
      const type = session.payload?.type === 'notfound' ? 'notfound' : 'join';
      let channelId = '';
      if ('text' in ctx.message && /^-?\\d+$/.test(ctx.message.text.trim())) {
        channelId = ctx.message.text.trim();
      } else if ('forward_origin' in ctx.message && ctx.message.forward_origin?.type === 'channel') {
        channelId = String(ctx.message.forward_origin.chat.id);
      }
      if (!channelId) {
        return ctx.reply('❌ I could not identify a channel. Send a numeric channel ID (for example <code>-1001234567890</code>) or forward a channel post. Send /cancel to stop.', { parse_mode: 'HTML' });
      }
      return configureNotificationChannel(ctx, type, channelId);
    }

    if (session.action === 'promo_create' && 'text' in ctx.message) {
      const input = ctx.message.text.trim();
      if (input === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('Promo creation cancelled.');
      }
      const payload = session.payload || {};
      if (session.step === 'awaiting_code') {
        const code = input.toUpperCase();
        if (code !== 'AUTO' && !/^[A-Z0-9_-]{3,64}$/.test(code)) {
          return ctx.reply('❌ Enter 3–64 letters, numbers, hyphens, or underscores, or send AUTO.');
        }
        await setAdminSession(ctx.from.id, 'promo_create', 'awaiting_reward', { code });
        return ctx.reply('➕ <b>Create Promo — Step 2 of 5</b>\n\nChoose the reward:', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('💎 Premium', 'promos:wizard:reward:premium')],
            [Markup.button.callback('⚡ Semi Premium', 'promos:wizard:reward:semi_premium')],
            [Markup.button.callback('∞ Unlimited Access', 'promos:wizard:reward:unlimited')],
            [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')],
          ]),
        });
      }
      if (session.step === 'awaiting_days') {
        const days = Number(input);
        if (!/^\\d+$/.test(input) || !Number.isInteger(days) || days < 1 || days > 3650) {
          return ctx.reply('❌ Send a whole number from 1 to 3650 days, or /cancel.');
        }
        await setAdminSession(ctx.from.id, 'promo_create', 'awaiting_uses', { ...payload, days });
        return ctx.reply('➕ <b>Create Promo — Step 4 of 5</b>\n\nHow many times can this code be redeemed in total? Send a positive number, or <code>-</code> for unlimited uses.', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('♾️ Unlimited Uses', 'promos:wizard:uses:unlimited')], [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]),
        });
      }
      if (session.step === 'awaiting_uses') {
        const maxUses = input === '-' ? null : Number(input);
        if (maxUses !== null && (!/^\\d+$/.test(input) || !Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
          return ctx.reply('❌ Send a number from 1 to 1000000, or - for unlimited uses.');
        }
        await setAdminSession(ctx.from.id, 'promo_create', 'awaiting_expiry', { ...payload, maxUses });
        return ctx.reply('➕ <b>Create Promo — Step 5 of 5</b>\n\nEnter an expiry date/time in ISO format (for example <code>2026-12-31T23:59:59Z</code>), or send <code>-</code> for no expiry.', {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('♾️ No Expiry', 'promos:wizard:expiry:none')], [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]),
        });
      }
      if (session.step === 'awaiting_expiry') {
        let expiresAt: string | null = null;
        if (input !== '-') {
          const parsed = new Date(input);
          if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= Date.now()) {
            return ctx.reply('❌ Enter a valid future date/time in ISO format, or send - for no expiry.');
          }
          expiresAt = parsed.toISOString();
        }
        const updated: Record<string, any> = { ...payload, expiresAt };
        await setAdminSession(ctx.from.id, 'promo_create', 'awaiting_confirmation', updated);
        const rewardText = updated.reward === 'unlimited' ? 'Unlimited access' : updated.reward === 'premium' ? 'Premium' : 'Semi Premium';
        const codeText = updated.code === 'AUTO' ? 'Auto-generated on confirmation' : escapeHtml(String(updated.code));
        return ctx.reply(
          `🧾 <b>Review Promo</b>\n\n🎟️ Code: <code>${codeText}</code>\n🎁 Reward: <b>${rewardText}</b>\n📅 Duration: <b>${updated.days} day(s)</b>\n👥 Max uses: <b>${updated.maxUses ?? 'Unlimited'}</b>\n⏰ Expiry: <b>${expiresAt ? escapeHtml(new Date(expiresAt).toLocaleString()) : 'No expiry'}</b>\n\nConfirm to create this promo.`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('✅ Confirm & Create', 'promos:wizard:confirm')], [Markup.button.callback('❌ Cancel', 'promos:wizard:cancel')]]) },
        );
      }
    }

    if (session.action === 'premium_package' && 'text' in ctx.message) {
      const input = ctx.message.text.trim();
      if (input === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('Premium package edit cancelled.');
      }
      const parts = input.split(/\s+/);
      const days = Number(parts[0]);
      const stars = Number(parts[1]);
      const label = parts.slice(2).join(' ').trim();
      if (!Number.isInteger(days) || days < 1 || days > 3650 ||
          !Number.isSafeInteger(stars) || stars < 1 || stars > 1000000 ||
          !label || label.length > 32) {
        return ctx.reply('❌ Invalid values. Send: <code>DAYS STARS LABEL</code> (days 1–3650, Stars 1–1000000, label 1–32 characters) or /cancel.', { parse_mode: 'HTML' });
      }
      const previousDays = session.step === 'awaiting_edit' ? Number(session.payload?.previousDays) : undefined;
      try {
        await savePremiumPackage({ days, stars, label, active: true }, previousDays);
        await clearAdminSession(ctx.from.id);
        await ctx.reply(`✅ Premium package saved\n\n💎 ${escapeHtml(label)}\n📅 Duration: ${days} days\n⭐ Price: ${stars} Telegram Stars\n\nCustomers will see this package in /premium.`, { parse_mode: 'HTML' });
        return showPremiumPackageManager(ctx);
      } catch (err) {
        return ctx.reply('❌ ' + escapeHtml(err instanceof Error ? err.message : String(err)) + '\nPlease try again or /cancel.', { parse_mode: 'HTML' });
      }
    }

    if (session.action === 'quota' && 'text' in ctx.message) {
      const input = ctx.message.text.trim();
      if (input === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('Quota edit cancelled.');
      }
      const value = Number(input);
      const plan = session.payload?.plan as 'free' | 'semi_premium' | undefined;
      if (!plan || !/^\d+$/.test(input) || !Number.isInteger(value) || value < 0 || value > 100000) {
        return ctx.reply('❌ Send a whole number from 0 to 100000, or /cancel.');
      }
      try {
        const q = await getDownloadQuotaSettings();
        await setDownloadQuotaSettings({ ...q, [plan]: value });
        const saved = await getDownloadQuotaSettings();
        if (saved[plan] !== value) throw new Error('The database did not return the new quota value.');
        await clearAdminSession(ctx.from.id);
        const label = plan === 'free' ? 'Free' : 'Semi Premium';
        await ctx.reply(`✅ ${label} quota saved: ${value}/day.`);
        return showQuotaPlanMenu(ctx);
      } catch (err) {
        console.error('[Quota] Custom value save failed:', err);
        return ctx.reply('❌ Could not save quota: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
      }
    }

    if (session.action === 'user_lookup' && 'text' in ctx.message) {
      const input = ctx.message.text.trim();
      if (input === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('User search cancelled.', { ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ User Management', 'admin:users')]]) });
      }
      if (!/^\d{1,20}$/.test(input) || !Number.isSafeInteger(Number(input))) {
        return ctx.reply('❌ Send a valid numeric Telegram user ID, or /cancel.');
      }
      const userId = Number(input);
      await clearAdminSession(ctx.from.id);
      try {
        return await showAdminUserProfile(ctx, userId);
      } catch (err) {
        return ctx.reply('❌ Could not load user profile: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
      }
    }

    // Step 0: Admin editing video metadata
    if (session.action === 'edit_video' && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('Edit cancelled.');
      }

      const videoId = String(session.payload.videoId);
      const code = String(session.payload.code || 'Video');

      try {
        if (session.step === 'title') {
          await updateVideoMetadata(videoId, { title: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Title updated for <code>${escapeHtml(code)}</code>:\n<i>${escapeHtml(text)}</i>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'actresses') {
          const actresses = text.split(/[,/]/).map(s => s.trim()).filter(Boolean);
          await updateVideoMetadata(videoId, { actresses });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Actresses updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(actresses.join(', '))}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'studio') {
          await updateVideoMetadata(videoId, { studio: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Studio updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(text)}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'duration') {
          await updateVideoMetadata(videoId, { duration: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Duration updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(text)}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        try {
          await recordMissedCode(code, errMsg);
        } catch (saveErr) {
          console.error('[MissedCodes] Could not persist code:', saveErr);
        }
        await setAdminSession(ctx.from.id, 'post', 'awaiting_manual_title', { code });
        return ctx.reply(
          `⚠️ Could not fetch metadata for ${code}: ${errMsg}\n\n✍️ Send the post title manually, or use /cancel to stop.\nThis code has been added to /missedcodes.`
        );
      }
    }

    if (session.action === 'broadcast' && session.step === 'awaiting_message' && 'text' in ctx.message) {
      const message = ctx.message.text.trim();
      if (!message) return ctx.reply('Send a non-empty message or /cancel.');
      if (message.length > 3500) return ctx.reply('Message is too long for a safe preview. Please keep it under 3500 characters or /cancel.');
      await setAdminSession(ctx.from.id, 'broadcast', 'awaiting_confirmation', { message });
      return ctx.reply(
        '📣 BROADCAST PREVIEW\n\n' + message + '\n\n⚠️ This will be sent to all active users. Continue?',
        { ...Markup.inlineKeyboard([
          [Markup.button.callback('✅ Send Broadcast', 'settings:broadcast:send')],
          [Markup.button.callback('❌ Cancel', 'settings:broadcast:cancel')],
        ]) },
      );
    }

    if (session.action === 'force_sub_add' && session.step === 'awaiting_channel' && 'text' in ctx.message) {
      const parts = ctx.message.text.trim().split('|').map(v => v.trim());
      const channelId = parts[0];
      const requestMode = /^(true|yes|1)$/i.test((parts[1] || '').replace(/^request\s*:\s*/i, ''));
      if (!channelId) return ctx.reply('Format: channel_id | request:true|false');
      try {
        const invite = await createForceSubInviteLink(bot, channelId, requestMode);
        const channel = await upsertForceSubChannel({
          channelId,
          title: invite.title,
          inviteLink: invite.inviteLink,
          requestMode,
          isActive: true,
        });
        await clearAdminSession(ctx.from.id);
        return ctx.reply(
          `✅ <b>Force-sub channel saved</b>\n\n📢 <b>${escapeHtml(channel.title)}</b>\n🆔 <code>${escapeHtml(channel.channel_id)}</code>\n🔗 <code>${escapeHtml(channel.invite_link || '')}</code>\n📨 Request mode: <b>${channel.request_mode ? 'ON' : 'OFF'}</b>\n\nYou can change request mode below.`,
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback(channel.request_mode ? '📨 Turn Request Mode OFF' : '📨 Turn Request Mode ON', `settings:forcesub:request:${channel.id}`)],
              [Markup.button.callback('⬅️ Force-sub Settings', 'settings:forcesub')],
            ]),
          },
        );
      } catch (err: unknown) {
        return ctx.reply('❌ Could not configure channel. Make sure the bot is an administrator with permission to create invite links.\n\n' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
      }
    }

    if (session.action !== 'post') {
      return next();
    }

    // Step 1: Admin entered code
    if (session.step === 'awaiting_code' && 'text' in ctx.message) {
      const code = normalizeCode(ctx.message.text);
      if (!code) {
        return ctx.reply('Invalid JAV code format. Please try again or use /cancel.');
      }

      await ctx.reply(`🔍 Fetching metadata from Javtiful for \`${code}\`...`, { parse_mode: 'Markdown' });

      try {
        const metadata = await javtifulProvider.getMetadata(code);
        await setAdminSession(ctx.from.id, 'post', 'awaiting_video', { code, metadata });

        const preview = [
          `✅ *Metadata Found:*`,
          `\n*Code:* \`${metadata.code}\``,
          `*Title:* ${metadata.title}`,
          `*Actresses:* ${metadata.actresses.join(', ') || 'N/A'}`,
          `*Duration:* ${metadata.duration || 'N/A'}`,
          `*Date:* ${metadata.date || 'N/A'}`,
          `\n📤 *Now please send or forward the video file:*`,
        ].join('\n');

        return ctx.replyWithMarkdown(preview);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await setAdminSession(ctx.from.id, 'post', 'awaiting_manual_title', { code });
        return ctx.reply(
          `⚠️ Could not fetch metadata for ${code}: ${errMsg}\n\n✍️ Send the post title manually, or use /cancel to stop.`
        );
      }
    }

    // Manual fallback: admin provides a title when provider metadata is unavailable.
    if (session.step === 'awaiting_manual_title' && 'text' in ctx.message) {
      const title = ctx.message.text.trim();
      if (!title) return ctx.reply('Please send a non-empty post title, or /cancel.');
      const payload = { ...(session.payload || {}), metadata: {
        code: String(session.payload?.code || ''),
        title,
        actresses: [],
        duration: '',
        date: '',
        thumbnailUrl: '',
      } };
      await setAdminSession(ctx.from.id, 'post', 'awaiting_thumbnail_url', payload);
      return ctx.reply('🖼️ Now send the thumbnail image URL (http:// or https://), or type SKIP to continue without a thumbnail.\n\nUse /cancel to stop.');
    }

    // Manual fallback: collect and validate the thumbnail URL.
    if (session.step === 'awaiting_thumbnail_url' && 'text' in ctx.message) {
      const thumbnailUrl = ctx.message.text.trim();
      const payload = { ...(session.payload || {}) };
      if (!/^skip$/i.test(thumbnailUrl)) {
        try {
          const parsed = new URL(thumbnailUrl);
          if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('invalid protocol');
        } catch {
          return ctx.reply('That does not look like a valid HTTP(S) URL. Send the thumbnail URL, SKIP, or /cancel.');
        }
      }
      payload.metadata = { ...(payload.metadata || {}), thumbnailUrl: /^skip$/i.test(thumbnailUrl) ? '' : thumbnailUrl };
      await setAdminSession(ctx.from.id, 'post', 'awaiting_manual_video', payload);
      return ctx.reply('📤 Now send or forward the video file (video or document), or use /cancel.');
    }

    // Step 2: Admin sent video file (automatic metadata or manual fallback)
    if (session.step === 'awaiting_video' || session.step === 'awaiting_manual_video') {
      const msg = ctx.message;
      const isVideo = 'video' in msg || 'document' in msg;

      if (!isVideo) {
        return ctx.reply('Please send a video or document file, or type /cancel.');
      }

      const { code, metadata } = session.payload as { code: string; metadata: any };
      await ctx.reply('⏳ Uploading / Copying video to Telegram Dump Channel...');

      try {
        // Forward video to dump channel
        const forwarded = await ctx.telegram.copyMessage(config.dumpChatId, ctx.chat.id, msg.message_id, {
          caption: `${code} - ${metadata.title}`,
        });

        const dumpVideoMessageId = forwarded.message_id;

        // Optionally send thumbnail to dump channel
        let thumbRef = null;
        if (metadata.thumbnailUrl) {
          thumbRef = await storeThumbnailInDumpChannel(bot, metadata.thumbnailUrl, code);
        }

        // Upsert into Supabase videos
        await upsertVideoFromProvider({
          code,
          dump_chat_id: config.dumpChatId,
          video_message_id: dumpVideoMessageId,
          metadata,
          thumbnail_message_id: thumbRef?.messageId,
          thumbnail_file_id: thumbRef?.fileId,
          status: 'available',
        });

        await removeMissedCode(code).catch((removeErr) => console.warn('[MissedCodes] Could not clear posted code:', removeErr));
        await clearAdminSession(ctx.from.id);

        return ctx.replyWithMarkdown(
          `🎉 *Success!* Video \`${code}\` has been published and linked to Dump Channel message \`#${dumpVideoMessageId}\`.`
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return ctx.reply(`❌ Failed to post video: ${errMsg}`);
      }
    }

    return next();
  });

  // 13. Generic text search handler
  bot.on('text', async (ctx) => {
    // Check force-sub for normal users
    if (ctx.from) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const buttons: any[] = forceSub.missingChannels.map(ch =>
          Markup.button.url(`Join ${ch.title}`, ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`)
        );
        buttons.push(Markup.button.callback('✅ Check Membership', 'check_sub'));
        return ctx.reply(
          '⚠️ You must join our channel(s) before searching:',
          Markup.inlineKeyboard(buttons.map(b => [b]))
        );
      }
    }

    await handleSearchQuery(ctx, ctx.message.text, 0);
  });

  return bot;
}

export function getActiveBotRole(): 'primary' | 'backup' {
  return getStoredActiveBotRole();
}

let cachedBotUsername: string | null = null;

export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  const bot = getBot();
  if (!bot) return null;

  try {
    const me = await bot.telegram.getMe();
    cachedBotUsername = me.username || null;
    return cachedBotUsername;
  } catch {
    return null;
  }
}

export function getBot(): Telegraf | null {
  if (botInstance) return botInstance;

  const role = availableRole(getStoredActiveBotRole());
  if (!role) return null;
  setActiveBotRole(role);

  const token = tokenForRole(role);
  botInstance = createBot(token);

  return botInstance;
}


export async function startBotPolling(): Promise<boolean> {
  if (isWebhookActive) {
    console.log('[TelegramBot] Webhook mode is already active.');
    return true;
  }
  if (isPollingActive) {
    console.log('[TelegramBot] Polling already active.');
    return true;
  }

  let role = availableRole(getStoredActiveBotRole());
  if (!role) {
    console.log('[TelegramBot] No bot token configured. Polling not started.');
    return false;
  }

  // Validate the selected token before polling. If the primary bot was deleted/revoked,
  // automatically recover with the backup bot without touching Supabase or dump messages.
  const validateAndBuild = async (candidate: 'primary' | 'backup'): Promise<Telegraf | null> => {
    const token = tokenForRole(candidate);
    if (!token) return null;
    const candidateBot = createBot(token);
    try {
      const me = await candidateBot.telegram.getMe();
      console.log(`[TelegramBot] ${candidate.toUpperCase()} bot validated: @${me.username || me.id}`);

      // Keep Telegram's native command menu discoverable. This is best-effort so a
      // command-menu API issue cannot prevent an otherwise valid bot from starting.
      await candidateBot.telegram.setMyCommands([
        { command: 'start', description: 'Open the main menu' },
        { command: 'search', description: 'Search the video catalog' },
        { command: 'dashboard', description: 'View your account dashboard' },
        { command: 'plan', description: 'Check your plan and limits' },
        { command: 'leaderboard', description: 'View referral leaderboard' },
        { command: 'help', description: 'How to use the bot' },
        { command: 'cancel', description: 'Cancel the current operation' },
      ]).catch(err => {
        console.warn('[TelegramBot] Could not register command menu:', err instanceof Error ? err.message : String(err));
      });

      // Verify the replacement bot can access the persistent dump channel.
      if (config.dumpChatId) {
        await candidateBot.telegram.getChat(config.dumpChatId);
        await candidateBot.telegram.getChatMember(config.dumpChatId, me.id);
      }
      return candidateBot;
    } catch (err: unknown) {
      const info = classifyTelegramError(err);
      console.error(`[TelegramBot] ${candidate.toUpperCase()} validation failed: ${info.message}`);
      return null;
    }
  };

  let bot = await validateAndBuild(role);
  if (!bot) {
    const fallback = role === 'primary' ? 'backup' : 'primary';
    if (!tokenForRole(fallback)) return false;
    console.warn(`[TelegramBot] Falling back from ${role} to ${fallback} bot.`);
    role = fallback;
    bot = await validateAndBuild(role);
  }

  if (!bot) {
    console.error('[TelegramBot] No configured bot could be validated. Polling not started.');
    return false;
  }

  setActiveBotRole(role);
  botInstance = bot;

  try {
    console.log(`[TelegramBot] Launching ${role} bot polling...`);
    await bot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(err => {
      console.warn('[TelegramBot] Could not clear an existing webhook before polling:', err instanceof Error ? err.message : String(err));
    });
    bot.launch({ dropPendingUpdates: false }).catch(err => {
      console.error('[TelegramBot] Polling error:', err?.message || err);
      isPollingActive = false;
    });
    isPollingActive = true;
    console.log(`[TelegramBot] ${role.toUpperCase()} bot polling started successfully.`);
    return true;
  } catch (err: unknown) {
    console.error('[TelegramBot] Failed to launch bot:', err);
    isPollingActive = false;
    botInstance = null;
    return false;
  }
}

/** Starts the configured Telegram bot using Telegram's HTTPS webhook delivery. */
export async function startBotWebhook(app: Express): Promise<boolean> {
  if (!config.webhookUrl || !config.webhookSecret) {
    console.error('[TelegramBot] Webhook mode requires both WEBHOOK_URL and WEBHOOK_SECRET.');
    return false;
  }
  if (isWebhookActive) {
    console.log('[TelegramBot] Webhook already active.');
    return true;
  }

  webhookApp = app;
  let role = availableRole(getStoredActiveBotRole());
  if (!role) {
    console.error('[TelegramBot] No bot token configured. Webhook not started.');
    return false;
  }

  const validateAndBuild = async (candidate: 'primary' | 'backup'): Promise<Telegraf | null> => {
    const token = tokenForRole(candidate);
    if (!token) return null;
    const candidateBot = createBot(token);
    try {
      const me = await candidateBot.telegram.getMe();
      console.log(`[TelegramBot] ${candidate.toUpperCase()} bot validated for webhook: @${me.username || me.id}`);
      await candidateBot.telegram.setMyCommands([
        { command: 'start', description: 'Open the main menu' },
        { command: 'search', description: 'Search the video catalog' },
        { command: 'dashboard', description: 'View your account dashboard' },
        { command: 'plan', description: 'Check your plan and limits' },
        { command: 'leaderboard', description: 'View referral leaderboard' },
        { command: 'help', description: 'How to use the bot' },
        { command: 'cancel', description: 'Cancel the current operation' },
      ]).catch(err => {
        console.warn('[TelegramBot] Could not register command menu:', err instanceof Error ? err.message : String(err));
      });
      if (config.dumpChatId) {
        await candidateBot.telegram.getChat(config.dumpChatId);
        await candidateBot.telegram.getChatMember(config.dumpChatId, me.id);
      }
      return candidateBot;
    } catch (err: unknown) {
      const info = classifyTelegramError(err);
      console.error(`[TelegramBot] ${candidate.toUpperCase()} webhook validation failed: ${info.message}`);
      return null;
    }
  };

  let bot = await validateAndBuild(role);
  if (!bot) {
    const fallback = role === 'primary' ? 'backup' : 'primary';
    if (!tokenForRole(fallback)) return false;
    console.warn(`[TelegramBot] Falling back from ${role} to ${fallback} bot for webhook mode.`);
    role = fallback;
    bot = await validateAndBuild(role);
  }
  if (!bot) {
    console.error('[TelegramBot] No configured bot could be validated. Webhook not started.');
    return false;
  }

  setActiveBotRole(role);
  botInstance = bot;

  // Register one route that always dispatches to the currently selected bot.
  if (!webhookRouteRegistered) {
    app.post(config.webhookPath, (req, res, next) => {
      const activeBot = botInstance;
      if (!activeBot) return res.status(503).send('Telegram bot is unavailable');
      return activeBot.webhookCallback(config.webhookPath, {
        secretToken: config.webhookSecret,
      })(req, res, next);
    });
    webhookRouteRegistered = true;
  }

  const webhookUrl = `${config.webhookUrl}${config.webhookPath}`;
  try {
    await bot.telegram.setWebhook(webhookUrl, {
      secret_token: config.webhookSecret,
      max_connections: 40,
      allowed_updates: ['message', 'channel_post', 'callback_query', 'pre_checkout_query'],
      drop_pending_updates: false,
    });
    isWebhookActive = true;
    isPollingActive = false;
    console.log(`[TelegramBot] Webhook enabled at ${webhookUrl}`);
    return true;
  } catch (err: unknown) {
    isWebhookActive = false;
    console.error('[TelegramBot] Failed to configure webhook:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/** Switches polling to the requested configured bot without changing persistent data. */
export function isBotRoleConfigured(role: 'primary' | 'backup'): boolean {
  return Boolean(tokenForRole(role));
}

export async function switchBotRole(role: 'primary' | 'backup'): Promise<boolean> {
  if (!tokenForRole(role)) return false;
  const previousBot = botInstance;
  if (isWebhookActive && previousBot) {
    await previousBot.telegram.deleteWebhook({ drop_pending_updates: false }).catch(() => undefined);
    isWebhookActive = false;
  }
  stopBotPolling();
  botInstance = null;
  setActiveBotRole(role);
  return webhookApp && config.webhookUrl && config.webhookSecret
    ? startBotWebhook(webhookApp)
    : startBotPolling();
}

export function stopBotPolling(): void {
  if (botInstance && isPollingActive) {
    try {
      botInstance.stop('Stopping bot instance');
    } catch {
      // Ignore
    }
    isPollingActive = false;
    console.log('[TelegramBot] Bot polling stopped.');
  }
}

export function isBotActive(): boolean {
  return isPollingActive || isWebhookActive;
}