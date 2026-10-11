import { Telegraf } from 'telegraf';
import { botDeps } from '../deps.ts';
const {
  Markup, config, isAdmin, normalizeCode, extractCodes, cleanActressList, cleanTitle,
  searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus,
  createIndexJob, countJobs, getRecentJobs, retryJob,
  upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getUser, getUserDashboard, getReferralLeaderboard,
  redeemPromoCode, createPromoCode, listPremiumPayments, listPromoCodes, setPromoCodeActive, completeStarPremiumPayment,
  consumeVideoDownload, refundVideoDownload, getDownloadQuotaSettings, setDownloadQuotaSettings, registerReferral, completeReferral, setUserPlan,
  checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink,
  getAdminSession, setAdminSession, clearAdminSession, javtifulProvider, sendDumpVideoToUser, storeThumbnailInDumpChannel,
  installMessageDeleteTimer, getSetting, setSetting, classifyTelegramError, withTelegramRetry, recordVideoDeliveryEvent, getVideoDeliveryAnalytics,
  deliverVideoToUser, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery,
  showForceSubAdminMenu, showAdminSettings, formatTimer, parsePremiumPayload, sendPremiumStore, sendPremiumInvoice,
} = botDeps;

export function registerUserCommands(bot: Telegraf) {
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
        const isVideoDeepLink = /^v_[0-9a-f-]{8,64}$/i.test(payload);
        return deliverVideoToUser(bot, ctx, isVideoDeepLink ? payload.slice(2) : payload, isVideoDeepLink ? 'deep_link' : 'unknown');
      }
  
      const welcome = [
        '<b>Welcome to PiratecultJAV Bot</b>',
        '',
        'Send a code or keyword to search the catalog.',
        '',
        '<b>Examples</b>',
        '<code>ADN-001</code>',
        '<code>STAR-765</code>',
        '<code>JUR-270</code>',
        '',
        'Type your code below.'
      ].join('\n');
  
      return ctx.reply(welcome, { parse_mode: 'HTML' });
    });

  bot.command('premium', async (ctx) => {
      return sendPremiumStore(ctx);
    });

  bot.command('promo', async (ctx) => {
      if (!ctx.from) return;
      const parts = ctx.message.text.trim().split(/\s+/);
      const code = parts[1]?.trim();
      if (!code) return ctx.reply('Usage: /promo <CODE>');
  
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

  bot.command('referral', async (ctx) => {
      if (!ctx.from) return;
      return sendReferralInfo(bot, ctx);
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
}
