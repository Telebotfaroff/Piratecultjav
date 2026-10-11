import { randomBytes } from 'node:crypto';
import { Telegraf, Markup } from 'telegraf';
import { config, isAdmin } from '../config.ts';
import { normalizeCode, cleanActressList, cleanTitle } from '../services/code.ts';
import { searchVideos, getVideoById, getVideoByCode, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus } from '../services/videos.ts';
import { countJobs } from '../services/indexJobs.ts';
import { consumeVideoDownload, refundVideoDownload, getUserDashboard, getReferralLeaderboard, completeReferral, countUsers } from '../services/users.ts';
import { checkUserForceSub, getAllForceSubChannels } from '../services/forceSub.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { sendDumpVideoToUser } from '../services/dump.ts';
import { recordVideoDeliveryEvent, getVideoDeliveryAnalytics } from '../services/videoAnalytics.ts';
import { getActiveBotRole } from './state.ts';

async function notifyNotFound(ctx: any, query: string, source: string): Promise<void> {
  try {
    const channel = await getSetting<string>('notification_not_found_channel', '');
    if (!channel) return;
    const user = ctx.from;
    const safe = (value: unknown) => escapeHtml(value ?? '—');
    const requestId = randomBytes(6).toString('hex');
    const pending = await getSetting<any[]>('not_found_alerts', []);
    const requests = Array.isArray(pending) ? pending : [];
    requests.push({
      id: requestId,
      userId: user?.id,
      query: String(query).slice(0, 120),
      source,
      createdAt: new Date().toISOString(),
      username: user?.username || null,
      firstName: user?.first_name || null,
    });
    await setSetting('not_found_alerts', requests.slice(-500));

    await ctx.telegram.sendMessage(
      channel,
      '🔎 <b>Search result not found</b>\n\nQuery: <code>' + safe(query) + '</code>' +
      '\nSource: ' + safe(source) +
      '\nUser: ' + safe(user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : 'Unknown') +
      '\nUsername: ' + safe(user?.username ? '@' + user.username : '—') +
      '\nUser ID: <code>' + safe(user?.id) + '</code>' +
      '\n\n<i>Tap below if you want the bot to notify this user when a matching video is added.</i>',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.callback('🔔 Notify user when added', 'notfound:watch:' + requestId)]]),
      },
    );
  } catch (err) {
    console.warn('[Notifications] Not-found notification failed:', err instanceof Error ? err.message : String(err));
  }
}

async function deliverVideoToUser(bot: Telegraf, ctx: any, identifier: string, source: 'deep_link' | 'search' | 'callback' | 'unknown' = 'unknown', options: { suppressDeleteReminderMessage?: boolean } = {}) {
  let quotaConsumed = false;
  try {
    await recordVideoDeliveryEvent({ eventType: 'attempt', telegramUserId: ctx.from?.id, source });
    const rawCode = identifier.trim();
    const norm = normalizeCode(rawCode);

    // 1. Try finding video by exact code or normalized code or database ID
    let video = await getVideoByCode(rawCode);
    if (!video && norm) {
      video = await getVideoByCode(norm);
    }
    if (!video) {
      video = await getVideoById(rawCode);
    }

    // 2. If not found by direct lookup, search catalog
    if (!video) {
      const { videos } = await searchVideos(norm || rawCode, 5, 0);
      if (videos.length === 1) {
        video = videos[0];
      } else if (videos.length > 1) {
        return handleSearchQuery(ctx, rawCode, 0);
      } else {
        await recordVideoDeliveryEvent({ eventType: 'not_found', telegramUserId: ctx.from?.id, code: rawCode, source });
        await notifyNotFound(ctx, rawCode, source);
        return ctx.reply(`❌ Video with code "${rawCode}" was not found in catalog.`);
      }
    }

    if (video.status !== 'available') {
      await recordVideoDeliveryEvent({ eventType: 'unavailable', telegramUserId: ctx.from?.id, videoId: video.id, code: video.code, source });
      return ctx.reply(`⚠️ Video *${video.code}* is currently marked as ${video.status}. Please check back later.`, {
        parse_mode: 'Markdown',
      });
    }

    // 3. Force-sub check
    if (ctx.from) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const buttons: any[] = forceSub.missingChannels.map(ch =>
          Markup.button.url(
            ch.request_mode ? `📨 Request to Join ${ch.title}` : `Join ${ch.title}`,
            ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`
          )
        );
        buttons.push(Markup.button.callback('🔄 Get Video', `download:${video.id}`));
        await recordVideoDeliveryEvent({ eventType: 'force_sub_block', telegramUserId: ctx.from?.id, videoId: video.id, code: video.code, source });
        return ctx.reply(
          `⚠️ *Access Required*\nPlease join our channel(s) below to receive *${video.code}*:`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons.map(b => [b])),
          }
        );
      }
    }

    // 4. Enforce the user's daily video allowance only after force-sub passes.
    // Admins are exempt. This also covers direct /start CODE links.
    if (ctx.from && !isAdmin(ctx.from.id)) {
      try {
        const allowance = await consumeVideoDownload(ctx.from.id);
        if (!allowance.allowed) {
          const planText = allowance.plan === 'semi_premium' ? 'Semi Premium (40/day)' : 'Free (20/day)';
          await recordVideoDeliveryEvent({ eventType: 'limit_block', telegramUserId: ctx.from?.id, videoId: video.id, code: video.code, source });
          return ctx.reply(
            `🚫 <b>Daily video limit reached</b>\n\nYour plan: <b>${planText}</b>\nCome back tomorrow or upgrade to Premium for unlimited videos.`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Plan', 'user:plan')], [Markup.button.callback('🔗 Refer & Earn', 'user:referral')]]) }
          );
        }
        quotaConsumed = true;
      } catch (err) {
        console.error('[Quota] Failed:', err);
        return ctx.reply('⚠️ Could not verify your daily download limit. Please try again.');
      }
    }

    // Match the reminder and caption to the admin-configured auto-delete timer.
    const { getAutoDeleteSeconds, formatAutoDeleteDuration } = await import('../services/messageDeleteTimer.ts');
    const deleteAfterSeconds = await getAutoDeleteSeconds();
    const deleteReminder = deleteAfterSeconds > 0
      ? `\n\n⏳ Auto-deletes in ${formatAutoDeleteDuration(deleteAfterSeconds)} — please forward it now to keep it.`
      : '';

    if (deleteAfterSeconds > 0 && !options.suppressDeleteReminderMessage) {
      try {
        await ctx.reply(
          `⏳ <b>Auto-delete reminder</b>\n\nThis video will be automatically deleted in <b>${formatAutoDeleteDuration(deleteAfterSeconds)}</b>. Please forward it to Saved Messages or another chat now if you want to keep it.`,
          { parse_mode: 'HTML' },
        );
      } catch (reminderError) {
        console.warn('[TelegramBot] Could not send auto-delete reminder:', reminderError instanceof Error ? reminderError.message : String(reminderError));
      }
    }

    // 5. Directly deliver the stored video to the user
    await sendDumpVideoToUser(
      bot,
      ctx.chat!.id,
      video.dump_chat_id,
      video.video_message_id,
      `🎬 *${video.code}* - ${video.title}${deleteReminder}`
    );

    await recordVideoDeliveryEvent({ eventType: 'delivered', telegramUserId: ctx.from?.id, videoId: video.id, code: video.code, source, success: true });

    // Referral reward is granted only after the referred user actually receives
    // their first video. The database function is atomic and one-time.
    if (ctx.from && !isAdmin(ctx.from.id)) {
      try {
        const referral = await completeReferral(ctx.from.id);
        if (referral.success) {
          await ctx.reply(
            '🎉 Referral completed! Your inviter earned +1 day of unlimited video access.'
          );
        }
      } catch (err) {
        console.warn('[Referral] Completion failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // A playful referral nudge appears only after the video was delivered successfully.
    if (ctx.from && !isAdmin(ctx.from.id)) {
      try {
        await ctx.reply(
          '😏 <b>Enjoying the goods?</b>\n\n' +
          'Don’t be selfish, you little troublemaker. 😈 Bring a partner-in-crime into the fun!\n\n' +
          '🎁 If your friend joins through your referral link and successfully gets their first video, you earn <b>+1 day of unlimited access</b>.\n\n' +
          '<i>Good friends share links. Best friends share the blame. 😂</i>',
          {
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('😈 Recruit a Partner-in-Crime', 'user:referral')],
              [Markup.button.callback('🙈 Maybe Later', 'referral:dismiss')],
            ]),
          },
        );
      } catch (err) {
        console.warn('[Referral] Could not show post-delivery prompt:', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TelegramBot] Failed direct video delivery for ${identifier}:`, errMsg);
    if (quotaConsumed && ctx.from && !isAdmin(ctx.from.id)) {
      try {
        const refunded = await refundVideoDownload(ctx.from.id);
        if (!refunded) console.warn('[Quota] Could not refund consumed allowance after failed delivery.');
      } catch (refundErr) {
        console.error('[Quota] Refund failed after delivery error:', refundErr);
      }
    }
    await recordVideoDeliveryEvent({ eventType: 'delivery_failed', telegramUserId: ctx.from?.id, code: identifier, source, errorMessage: errMsg });
    return ctx.reply('⚠️ Failed retrieving the requested item. Please try again later.');
  }
}

async function showAdminVideoEditMenu(ctx: any, videoId: string) {
  const video = await getVideoById(videoId);
  if (!video) {
    return ctx.reply('Video not found.');
  }

  const actresses = cleanActressList(video.metadata?.actresses);
  const text = [
    `✏️ <b>Admin Edit:</b> <code>${escapeHtml(video.code)}</code>`,
    ``,
    `📌 <b>Title:</b> <i>${escapeHtml(video.title)}</i>`,
    `💃 <b>Cast:</b> ${escapeHtml(actresses.join(', ') || 'None')}`,
    `🏢 <b>Studio:</b> ${escapeHtml(video.metadata?.studio || 'None')}`,
    `⏱ <b>Duration:</b> ${escapeHtml(video.metadata?.duration || 'None')}`,
    `📊 <b>Status:</b> ${video.status === 'available' ? '🟢 Available' : '🔴 Disabled'}`,
    ``,
    `<i>Tap a button below to update:</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📝 Edit Title', `admin:vid:set:title:${video.id}`),
      Markup.button.callback('💃 Edit Cast', `admin:vid:set:actresses:${video.id}`),
    ],
    [
      Markup.button.callback('🏢 Edit Studio', `admin:vid:set:studio:${video.id}`),
      Markup.button.callback('⏱ Edit Duration', `admin:vid:set:duration:${video.id}`),
    ],
    [
      Markup.button.callback('🔄 Refresh Metadata', `admin:vid:refresh:${video.id}`),
      Markup.button.callback(video.status === 'available' ? '🔴 Disable Video' : '🟢 Enable Video', `admin:vid:toggle_status:${video.id}`),
    ],
    [
      Markup.button.callback('🗑️ Delete Video', `admin:vid:del_confirm:${video.id}`),
    ],
    [
      Markup.button.callback('❌ Close', 'admin:vid:cancel'),
    ],
  ]);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {
      return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

async function sendReferralLeaderboard(ctx: any) {
  if (!ctx.from) return;

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Refer & Earn', 'user:referral')],
    [Markup.button.callback('⬅️ My Dashboard', 'user:plan')],
  ]);
  const show = async (text: string) => {
    if (ctx.callbackQuery) {
      try {
        return await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
      } catch (err) {
        // Telegram returns "message is not modified" when the screen is already current.
        if (err instanceof Error && /message is not modified/i.test(err.message)) return;
        return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
      }
    }
    return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
  };

  try {
    const entries = await getReferralLeaderboard(10);
    if (!entries.length) {
      return show('🏆 <b>Referral Leaderboard</b>\n\nNo completed referrals yet. Be the first to invite someone!');
    }

    const lines = ['🏆 <b>Referral Leaderboard</b>', '', '<i>Ranked by completed referrals</i>', ''];
    entries.forEach((entry, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `<b>#${index + 1}</b>`;
      lines.push(`${medal} <b>${escapeHtml(entry.display_name)}</b> — <b>${entry.completed_referrals}</b> completed / ${entry.total_referrals} invited`);
    });

    const mine = entries.findIndex(entry => entry.telegram_user_id === ctx.from.id);
    lines.push('', mine >= 0 ? `📍 <b>Your rank:</b> #${mine + 1}` : '📍 <b>Your rank:</b> outside the top 10');
    return show(lines.join('\n'));
  } catch (err) {
    console.error('[Referral] Leaderboard failed:', err);
    return show('⚠️ Could not load the referral leaderboard. Please try again later.');
  }
}

async function sendUserPlan(ctx: any) {
  if (!ctx.from) return;
  const dashboard = await getUserDashboard(ctx.from.id);
  if (!dashboard) return ctx.reply('⚠️ Your account is not ready yet. Please send /start again.');

  const planName = dashboard.plan === 'premium' ? '💎 Premium'
    : dashboard.plan === 'semi_premium' ? '⚡ Semi Premium'
    : '🆓 Free';

  const expiry = dashboard.plan_expires_at
    ? `\n📅 Plan expires: <b>${escapeHtml(new Date(dashboard.plan_expires_at).toLocaleString())}</b>`
    : dashboard.plan === 'premium' ? '\n📅 Plan: <b>Permanent</b>' : '';

  const bonus = dashboard.unlimited_until && new Date(dashboard.unlimited_until).getTime() > Date.now()
    ? `\n🎁 Unlimited bonus until: <b>${escapeHtml(new Date(dashboard.unlimited_until).toLocaleString())}</b>`
    : '';

  const remaining = dashboard.is_unlimited ? '∞' : String(dashboard.daily_remaining);
  const referrals = dashboard.referral_count;
  const completed = dashboard.completed_referral_count;

  const text = [
    '📊 <b>Your Dashboard</b>',
    '',
    `👤 User ID: <code>${ctx.from.id}</code>`,
    `⭐ Plan: <b>${planName}</b>`,
    `🎬 Today: <b>${remaining}</b> downloads remaining${dashboard.is_unlimited ? '' : ` / ${dashboard.daily_limit}`}`,
    `📈 Used today: <b>${dashboard.daily_used}</b>`,
    expiry,
    bonus,
    '',
    '🤝 <b>Referrals</b>',
    `👥 Invited: <b>${referrals}</b>`,
    `✅ Completed: <b>${completed}</b>`,
    '',
    '<i>A referral becomes completed only after the invited user successfully receives their first video.</i>',
  ].filter(Boolean).join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🔗 Refer & Earn', 'user:referral')],
    [Markup.button.callback('🎟️ Promo Code', 'user:promo')],
    [Markup.button.callback('💎 Buy Premium', 'premium:store'), Markup.button.callback('🏆 Leaderboard', 'user:leaderboard')],
    [Markup.button.callback('🔄 Refresh', 'user:plan')],
  ]);
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

async function sendReferralInfo(bot: Telegraf, ctx: any) {
  if (!ctx.from) return;
  const me = await bot.telegram.getMe();
  const username = me.username;
  if (!username) return ctx.reply('⚠️ Referral link is temporarily unavailable.');
  const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
  const text = `🔗 <b>Refer & Earn</b>\n\nInvite a new user with your personal link. After the new user passes required membership checks and successfully receives their first video, you receive <b>1 day of unlimited video access</b>.\n\n🎬 Free: 20 videos/day\n⚡ Semi Premium: 40 videos/day\n💎 Premium: Unlimited\n\n<b>Your referral link:</b>\n<code>${escapeHtml(link)}</code>`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('⬅️ My Dashboard', 'user:plan')]]);
  if (ctx.callbackQuery) {
    try {
      return await ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
    } catch (err) {
      if (err instanceof Error && /message is not modified/i.test(err.message)) return;
      return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    }
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleSearchQuery(ctx: any, rawQuery: string, page = 0) {
  const pageSize = 5;
  const offset = page * pageSize;

  try {
    // Enforce force-sub for direct searches and callback-based pagination too.
    // Previously the generic text handler checked membership, but callback searches
    // could call this function directly and bypass the gate.
    if (ctx.from) {
      const forceSub = await checkUserForceSub(ctx.bot, ctx.from.id);
      if (!forceSub.passed) {
        const rows: any[] = forceSub.missingChannels.map(ch => [
          Markup.button.url(
            ch.request_mode ? '📨 Request to Join ' + ch.title : 'Join ' + ch.title,
            ch.invite_link || 'https://t.me/' + ch.channel_id.replace('@', ''),
          ),
        ]);
        rows.push([Markup.button.callback('✅ Check Membership', 'check_sub')]);
        const gateText = '🔒 <b>Join the required channel(s) first</b>\n\nSubscribe to every channel below, then tap Check Membership to continue.';
        if (ctx.callbackQuery) {
          try {
            await ctx.editMessageText(gateText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
          } catch {
            await ctx.reply(gateText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
          }
        } else {
          await ctx.reply(gateText, { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
        }
        return;
      }
    }

    const { videos, total } = await searchVideos(rawQuery, pageSize, offset);

    if (videos.length === 0) {
      await notifyNotFound(ctx, rawQuery, 'catalog search');
      const msg = `❌ No videos found matching <b>${escapeHtml(rawQuery)}</b>.\n\n💡 <i>Try searching with a code (e.g. <code>ADN-001</code>, <code>ROYD-312</code>) or keyword.</i>`;
      if (ctx.callbackQuery) {
        return ctx.editMessageText(msg, { parse_mode: 'HTML' }).catch(() => ctx.reply(msg, { parse_mode: 'HTML' }));
      }
      return ctx.reply(msg, { parse_mode: 'HTML' });
    }

    const totalPages = Math.ceil(total / pageSize);

    let html = `🔍 <b>Search Results for:</b> <code>${escapeHtml(rawQuery)}</code>\n`;
    html += `📊 <b>Found:</b> ${total} video${total === 1 ? '' : 's'} · <b>Page:</b> ${page + 1}/${totalPages}\n`;
    html += `─────────────────────────\n\n`;

    const keyboardButtons: any[] = [];

    const userIsAdmin = Boolean(ctx.from && isAdmin(ctx.from.id));

    videos.forEach((v, idx) => {
      const num = offset + idx + 1;
      const displayTitle = cleanTitle(v.title, v.code);
      const truncatedTitle = displayTitle.length > 70 ? displayTitle.slice(0, 67) + '...' : displayTitle;
      const actresses = cleanActressList(v.metadata?.actresses);

      html += `<b>${num}.</b> 🏷️ <code>${escapeHtml(v.code)}</code>\n`;
      html += `📌 <i>${escapeHtml(truncatedTitle)}</i>\n`;

      if (actresses.length > 0) {
        html += `💃 <b>Cast:</b> ${escapeHtml(actresses.join(', '))}\n`;
      }

      const metaParts: string[] = [];
      if (v.metadata?.duration) {
        metaParts.push(`⏱ ${escapeHtml(v.metadata.duration)}`);
      }
      if (v.metadata?.studio) {
        metaParts.push(`🏢 ${escapeHtml(v.metadata.studio)}`);
      }
      if (metaParts.length > 0) {
        html += `ℹ️ ${metaParts.join(' · ')}\n`;
      }

      html += `\n`;

      if (userIsAdmin) {
        keyboardButtons.push([
          Markup.button.callback(`🎬 Get ${v.code}`, `download:${v.id}`),
          Markup.button.callback(`✏️ Edit`, `admin:vid:edit:${v.id}`),
          Markup.button.callback(`🗑️ Delete`, `admin:vid:del_confirm:${v.id}`),
        ]);
      } else {
        keyboardButtons.push([Markup.button.callback(`🎬 Get ${v.code}`, `download:${v.id}`)]);
      }
    });

    html += `─────────────────────────\n`;
    html += `👇 <i>Tap a button below to get the video directly:</i>`;

    // Bulk delivery applies to every match for this query, not only the visible page.
    keyboardButtons.push([
      Markup.button.callback(`⬇️ Download All (${total})`, 'downloadall:confirm'),
    ]);

    // Pagination row
    const navRow: any[] = [];
    if (page > 0) {
      navRow.push(Markup.button.callback('⬅️ Prev', `search:${rawQuery}:${page - 1}`));
    }
    if (totalPages > 1) {
      navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, `search:${rawQuery}:${page}`));
    }
    if (page + 1 < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `search:${rawQuery}:${page + 1}`));
    }

    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }

    if (ctx.callbackQuery) {
      return ctx.editMessageText(html, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(keyboardButtons),
      }).catch(() => {
        return ctx.reply(html, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(keyboardButtons),
        });
      });
    }

    return ctx.reply(html, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(keyboardButtons),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return ctx.reply(`⚠️ Search error: ${errMsg}`);
  }
}

async function downloadAllSearchResults(bot: Telegraf, ctx: any, rawQuery: string) {
  const query = String(rawQuery || '').trim();
  if (!ctx.from || !query) return ctx.reply('⚠️ I could not identify the search query. Please search again.');

  try {
    const videos: any[] = [];
    let total = 0;
    let offset = 0;
    do {
      const result = await searchVideos(query, 100, offset);
      total = result.total;
      videos.push(...result.videos);
      offset += result.videos.length;
      if (result.videos.length === 0) break;
    } while (offset < total);

    if (!videos.length) {
      await notifyNotFound(ctx, query, 'download all search results');
      return ctx.reply('❌ No available videos were found for <b>' + escapeHtml(query) + '</b>.', { parse_mode: 'HTML' });
    }

    if (!isAdmin(ctx.from.id)) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const rows = forceSub.missingChannels.map(ch => [
          Markup.button.url(
            ch.request_mode ? '📨 Request to Join ' + ch.title : 'Join ' + ch.title,
            ch.invite_link || 'https://t.me/' + ch.channel_id.replace('@', ''),
          ),
        ]);
        return ctx.reply(
          '🔒 <b>Join the required channel(s) first</b>\n\nThen run the search again and tap Download All.',
          { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
        );
      }
    }

    let processed = 0;
    let skippedForQuota = false;
    for (let index = 0; index < videos.length; index++) {
      if (!isAdmin(ctx.from.id)) {
        const dashboard = await getUserDashboard(ctx.from.id);
        if (!dashboard) {
          await ctx.reply('⚠️ Could not load your account allowance. Bulk delivery stopped.');
          break;
        }
        if (!dashboard.is_unlimited && dashboard.daily_remaining <= 0) {
          skippedForQuota = true;
          break;
        }
      }

      await deliverVideoToUser(bot, ctx, String(videos[index].id), 'search', {
        suppressDeleteReminderMessage: true,
      });
      processed++;

      // Avoid flooding the same Telegram chat; deliver one result at a time.
      if (index < videos.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1100));
      }
    }

    const summary = [
      '✅ <b>Download All run finished</b>',
      '',
      '🔎 Search: <code>' + escapeHtml(query) + '</code>',
      '📚 Matching videos: <b>' + total + '</b>',
      '📤 Delivery attempts: <b>' + processed + '</b>',
      skippedForQuota
        ? '🚫 Stopped because your daily download allowance is used up. Upgrade your plan or try again tomorrow.'
        : processed < total
          ? 'ℹ️ Processing stopped before all matches were attempted. Please try again if needed.'
          : '🎉 All matching results were processed.',
    ].filter(Boolean).join('\n');
    return ctx.reply(summary, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('📊 My Account', 'user:plan')],
        [Markup.button.callback('🔎 Search Again', 'menu:search')],
      ]),
    });
  } catch (err) {
    console.error('[BulkDownload] Failed:', err);
    return ctx.reply('⚠️ Bulk delivery failed while processing this search. Please try again.');
  }
}

async function showForceSubAdminMenu(ctx: any) {
  const enabled = await getSetting<boolean>('force_sub_enabled', false);
  const channels = await getAllForceSubChannels();
  const lines = ['🔒 <b>Force Subscribe</b>', '', 'Global: <b>' + (enabled ? 'ON' : 'OFF') + '</b>', ''];
  if (!channels.length) lines.push('No channels configured.');
  for (const ch of channels) lines.push((ch.is_active ? '🟢' : '🔴') + ' <b>' + escapeHtml(ch.title) + '</b> — <code>' + escapeHtml(ch.channel_id) + '</code> · Request: ' + (ch.request_mode ? 'ON' : 'OFF'));
  const rows: any[] = [
    [Markup.button.callback(enabled ? '🔴 Disable Global' : '🟢 Enable Global', 'settings:forcesub:toggle')],
    [Markup.button.callback('➕ Add Channel', 'settings:forcesub:add')],
  ];
  for (const ch of channels) {
    rows.push([
      Markup.button.callback((ch.is_active ? '🔴 Disable ' : '🟢 Enable ') + ch.title.slice(0, 14), 'settings:forcesub:toggle-channel:' + ch.id),
      Markup.button.callback(ch.request_mode ? '📨 Request: ON' : '📨 Request: OFF', 'settings:forcesub:request:' + ch.id),
    ]);
    rows.push([
      Markup.button.callback('🧪 Test ' + ch.title.slice(0, 18), 'settings:forcesub:test:' + ch.id),
      Markup.button.callback('🗑️ Delete', 'settings:forcesub:delete:' + ch.id),
    ]);
  }
  rows.push([Markup.button.callback('🔄 Refresh', 'settings:forcesub')]);
  rows.push([Markup.button.callback('⬅️ Admin Center', 'settings:main')]);
  if (ctx.callbackQuery) return ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  return ctx.reply(lines.join('\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
}

async function showAdminSettings(ctx: any) {
  const [users, videos, jobs, deleteTimer, forceSub, maintenance] = await Promise.all([
    countUsers(), countVideos(), countJobs(),
    getSetting<number>('delete_timer_seconds', 0),
    getSetting<boolean>('force_sub_enabled', false),
    getSetting<boolean>('maintenance_mode', false),
  ]);

  const text = [
    '🛡️ <b>PIRATECULTJAV ADMIN CENTER</b>',
    '',
    '📈 <b>Quick Overview</b>',
    `👥 Users: <b>${users}</b>  ·  🎬 Videos: <b>${videos}</b>`,
    `⚙️ Jobs: <b>${jobs.queued}</b> queued · <b>${jobs.processing}</b> processing`,
    `🤖 Bot: <b>ONLINE</b> · ${getActiveBotRole().toUpperCase()}`,
    '',
    '🔐 <b>Access</b>',
    `🔒 Force Sub: <b>${forceSub ? 'ON' : 'OFF'}</b>`,
    `🛠️ Maintenance: <b>${maintenance ? 'ON' : 'OFF'}</b>`,
    `🗑️ Auto Delete: <b>${formatTimer(deleteTimer)}</b>`,
    '',
    'Choose an admin section:',
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Overview', 'admin:overview'), Markup.button.callback('👥 Users', 'admin:users')],
    [Markup.button.callback('💰 Monetization', 'admin:monetization'), Markup.button.callback('📥 Quotas', 'admin:quota')],
    [Markup.button.callback('🎬 Content', 'admin:content'), Markup.button.callback('⚙️ Jobs', 'admin:jobs')],
    [Markup.button.callback('📣 Broadcast', 'settings:broadcast'), Markup.button.callback('🔒 Force Sub', 'settings:forcesub')],
    [Markup.button.callback('🧾 Missing Metadata', 'admin:missedcodes')],
    [Markup.button.callback('🔔 Notification Channels', 'settings:notifications')],
    [Markup.button.callback('🛠️ System', 'admin:system'), Markup.button.callback('🔄 Recovery', 'settings:recovery')],
    [Markup.button.callback('❌ Close', 'settings:close')],
  ]);

  if (ctx.callbackQuery) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

function formatTimer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'OFF';
  if (seconds % 86400 === 0) return seconds / 86400 + ' day(s)';
  if (seconds % 3600 === 0) return seconds / 3600 + ' hour(s)';
  if (seconds % 60 === 0) return seconds / 60 + ' minute(s)';
  return seconds + ' second(s)';
}

export { deliverVideoToUser, downloadAllSearchResults, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery, showForceSubAdminMenu, showAdminSettings, formatTimer };
