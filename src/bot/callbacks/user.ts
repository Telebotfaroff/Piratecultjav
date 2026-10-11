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

export function registerUserCallbacks(bot: Telegraf) {
  bot.action('premium:store', async (ctx) => {
      if (!ctx.from) return ctx.answerCbQuery();
      await ctx.answerCbQuery();
      return sendPremiumStore(ctx);
    });

  bot.action('user:promo', async (ctx) => {
      if (!ctx.from) return ctx.answerCbQuery();
      await ctx.answerCbQuery();
      return ctx.reply('🎟️ <b>Redeem Promo</b>\n\nUse <code>/promo YOUR_CODE</code> to redeem a promo code.', { parse_mode: 'HTML' });
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
}
