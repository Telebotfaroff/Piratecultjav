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
  deliverVideoToUser, deliverMediaPartGroup, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery,
  showForceSubAdminMenu, showAdminSettings, formatTimer, parsePremiumPayload, sendPremiumStore, sendPremiumInvoice,
} = botDeps;

export function registerContentCallbacks(bot: Telegraf) {
  bot.action(/^downloadparts:([0-9a-f-]+)$/i, async (ctx) => { await ctx.answerCbQuery('Preparing all parts...'); return deliverMediaPartGroup(bot, ctx, ctx.match[1]); });

  bot.action(/^download:(.+)$/, async (ctx) => {
      const identifier = ctx.match[1];
      await ctx.answerCbQuery('Fetching video...');
      return deliverVideoToUser(bot, ctx, identifier);
    });

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

  bot.action(/^search:(.+):(\d+)$/, async (ctx) => {
      const query = ctx.match[1];
      const page = parseInt(ctx.match[2], 10) || 0;
      await ctx.answerCbQuery();
  
      await handleSearchQuery(ctx, query, page);
    });
}
