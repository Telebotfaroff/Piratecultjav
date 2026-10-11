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

export function registerAdminCommands(bot: Telegraf) {
  bot.command('cancel', async (ctx) => {
      if (ctx.from) {
        await clearAdminSession(ctx.from.id);
      }
      return ctx.reply('Current operation canceled.');
    });

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

  bot.command('post', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) {
        return ctx.reply('Unauthorized: Admin access required.');
      }
  
      await setAdminSession(ctx.from.id, 'post', 'awaiting_code');
      return ctx.reply('📝 *Admin Post:* Please enter the JAV code to post (e.g. `ADN-001`):', {
        parse_mode: 'Markdown',
      });
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
      try {
        const promos = await listPromoCodes(20);
        if (!promos.length) return ctx.reply('🎟️ No promo codes found.');
        const lines = promos.map((p, i) => {
          const reward = p.reward_type === 'unlimited' ? `∞ ${p.reward_days}d unlimited` : `${p.reward_plan} ${p.reward_days}d`;
          const usage = p.max_uses === null ? `${p.used_count}/∞` : `${p.used_count}/${p.max_uses}`;
          const expiry = p.expires_at ? new Date(p.expires_at).toLocaleString() : 'never';
          return `${i + 1}. <code>${escapeHtml(p.code)}</code> · ${p.is_active ? '🟢' : '🔴'} · ${reward} · ${usage} · exp: ${escapeHtml(expiry)}`;
        });
        return ctx.reply('🎟️ <b>Promo Codes</b>\n\n' + lines.join('\n'), {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Monetization', 'admin:monetization')]]),
        });
      } catch (err) {
        console.error('[Promo] List failed:', err);
        return ctx.reply('❌ Could not load promo codes.');
      }
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
      const code = parts[1]?.trim().toUpperCase();
      const reward = parts[2]?.toLowerCase();
      const days = Number(parts[3]);
      const maxUsesRaw = parts[4];
      const expiryRaw = parts[5];
  
      if (!code || !['premium', 'semi_premium', 'unlimited'].includes(reward) || !Number.isInteger(days) || days <= 0) {
        return ctx.reply(
          'Usage:\n/createpromo <CODE> <premium|semi_premium|unlimited> <days> [max_uses] [expiry_iso]\n\nExample: /createpromo WELCOME30 premium 30 100'
        );
      }
  
      const maxUses = maxUsesRaw && maxUsesRaw !== '-' ? Number(maxUsesRaw) : null;
      if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
        return ctx.reply('❌ max_uses must be a positive integer.');
      }
  
      let expiresAt: string | null = null;
      if (expiryRaw && expiryRaw !== '-') {
        const parsed = new Date(expiryRaw);
        if (Number.isNaN(parsed.getTime())) return ctx.reply('❌ Invalid expiry. Use ISO format, e.g. 2026-12-31T23:59:59Z.');
        expiresAt = parsed.toISOString();
      }
  
      const rewardType = reward === 'unlimited' ? 'unlimited' : 'plan';
      const rewardPlan = rewardType === 'plan' ? reward as 'premium' | 'semi_premium' : null;
  
      try {
        const ok = await createPromoCode(code, rewardType, rewardPlan, days, maxUses, expiresAt, ctx.from!.id);
        if (!ok) return ctx.reply('❌ Could not create promo. The code may already exist or the reward settings are invalid.');
  
        return ctx.reply(
          `✅ <b>Promo created</b>\n\n🎟️ Code: <code>${escapeHtml(code)}</code>\n🎁 Reward: <b>${rewardType === 'unlimited' ? `Unlimited for ${days} day(s)` : `${rewardPlan} for ${days} day(s)`}</b>\n👥 Uses: <b>${maxUses ?? 'Unlimited'}</b>${expiresAt ? `\n⏰ Expires: <b>${escapeHtml(new Date(expiresAt).toLocaleString())}</b>` : ''}`,
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        console.error('[Promo] Create failed:', err);
        return ctx.reply('❌ Failed to create promo code.');
      }
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
      const parts = ctx.message.text.trim().split(/\s+/);
      const free = Number(parts[1]);
      const semiPremium = Number(parts[2]);
      if (!Number.isInteger(free) || free < 0 || free > 100000 || !Number.isInteger(semiPremium) || semiPremium < 0 || semiPremium > 100000) {
        return ctx.reply('Usage: /setquota <free_daily_limit> <semi_premium_daily_limit>\n\nExample: /setquota 20 40');
      }
      try {
        await setDownloadQuotaSettings({ free, semi_premium: semiPremium });
        return ctx.reply(
          '✅ <b>Download quotas updated</b>\n\n' +
          `🆓 Free: <b>${free}/day</b>\n` +
          `⚡ Semi Premium: <b>${semiPremium}/day</b>\n` +
          '💎 Premium: <b>Unlimited</b>',
          { parse_mode: 'HTML' },
        );
      } catch (err) {
        console.error('[Quota] Update failed:', err);
        return ctx.reply('❌ Failed to save download quotas.');
      }
    });

  bot.command('quota', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
      try {
        const q = await getDownloadQuotaSettings();
        return ctx.reply(
          '📥 <b>Download Quotas</b>\n\n' +
          `🆓 Free: <b>${q.free}/day</b>\n` +
          `⚡ Semi Premium: <b>${q.semi_premium}/day</b>\n` +
          '💎 Premium: <b>Unlimited</b>\n\n' +
          'Change with <code>/setquota FREE SEMI_PREMIUM</code>.',
          { parse_mode: 'HTML' },
        );
      } catch {
        return ctx.reply('❌ Could not load download quotas.');
      }
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
          `✅ <b>Force-sub channel added</b>\n\n📢 <b>${escapeHtml(channel.title)}</b>\n🆔 <code>${escapeHtml(channel.channel_id)}</code>\n🔗 <code>${escapeHtml(channel.invite_link || '')}</code>\n📨 Request mode: <b>${channel.request_mode ? 'ON' : 'OFF'}</b>`,
          { parse_mode: 'HTML' },
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

  bot.command('settings', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
      return showAdminSettings(ctx);
    });

  bot.command('admin', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
      return showAdminSettings(ctx);
    });
}
