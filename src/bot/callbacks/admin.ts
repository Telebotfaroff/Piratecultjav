import { Telegraf } from 'telegraf';
import { getActiveBotRole, isBotRoleConfigured, switchBotRole } from '../index.ts';
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

export function registerAdminCallbacks(bot: Telegraf) {
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

  bot.action('admin:users', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await ctx.answerCbQuery();
      const users = await countUsers();
      return ctx.editMessageText(
        '👥 <b>User Management</b>\n\n' +
        `Total users: <b>${users}</b>\n\n` +
        'Use the commands below for direct actions:',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('📣 Broadcast', 'settings:broadcast')],
            [Markup.button.callback('⬅️ Back', 'settings:main')],
          ]),
        },
      );
    });

  bot.action('admin:quota', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await ctx.answerCbQuery();
      const q = await getDownloadQuotaSettings();
      return ctx.editMessageText(
        '📥 <b>Download Quotas</b>\n\n' +
        `🆓 Free: <b>${q.free}/day</b>\n` +
        `⚡ Semi Premium: <b>${q.semi_premium}/day</b>\n` +
        '💎 Premium: <b>Unlimited</b>\n\n' +
        'Use <code>/setquota FREE SEMI_PREMIUM</code> to change the limits.',
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings:main')]]) },
      );
    });

  bot.action('admin:monetization', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await ctx.answerCbQuery();
      return ctx.editMessageText(
        '💰 <b>Monetization</b>\n\n' +
        `💎 Premium 7d: <b>${config.premium7Stars} ⭐</b>\n` +
        `💎 Premium 30d: <b>${config.premium30Stars} ⭐</b>\n` +
        `💎 Premium 90d: <b>${config.premium90Stars} ⭐</b>\n\n` +
        '🎟️ Promo codes are managed with <code>/createpromo</code>.\n' +
        '👤 Manual access is managed with <code>/setplan</code>.\n' +
        '📥 Daily quotas are managed with <code>/setquota</code>.',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🎟️ Promo Help', 'admin:promo_help'), Markup.button.callback('📋 Promo List', 'admin:promos')],
            [Markup.button.callback('⬅️ Back', 'settings:main')],
          ]),
        },
      );
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
        ? jobs.map(j => `${statusIcon(j.status)} <b>#${j.id}</b>  <code>${escapeHtml(j.code)}</code>  <i>${escapeHtml(j.status)}</i>`)
        : ['No recent jobs.'];
      return ctx.editMessageText('⚙️ <b>Recent Jobs</b>\n\n' + lines.join('\n'), {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')], [Markup.button.callback('🔄 Refresh', 'admin:jobs')]]),
      });
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

  bot.action('settings:forcesub', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await ctx.answerCbQuery();
      const enabled = await getSetting<boolean>('force_sub_enabled', false);
      return showForceSubAdminMenu(ctx);
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

  bot.action(/^settings:forcesub:delete:(.+)$/, async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await deleteForceSubChannel(ctx.match[1]);
      await ctx.answerCbQuery('Deleted.');
      return showForceSubAdminMenu(ctx);
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
      const active = getActiveBotRole() === 'primary' ? 'PRIMARY' : 'BACKUP';
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
      if (!isBotRoleConfigured(role)) return ctx.answerCbQuery(`${role === 'primary' ? 'Primary' : 'Backup'} token is not configured.`);
      await ctx.answerCbQuery('Switching bot...');
      const started = await switchBotRole(role);
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

  bot.action(/^premium:buy:(\d+)$/, async (ctx) => {
      if (!ctx.from) return ctx.answerCbQuery();
      await ctx.answerCbQuery();
      return sendPremiumInvoice(ctx, Number(ctx.match[1]));
    });

  bot.action('admin:vid:cancel', async (ctx) => {
      if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
      await ctx.answerCbQuery('Closed.');
      return ctx.deleteMessage().catch(() => undefined);
    });
}
