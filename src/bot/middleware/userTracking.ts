import { Telegraf } from 'telegraf';
import { trackTelegramUser } from '../../services/users.ts';
import { getSetting } from '../../services/settings.ts';
import { isAdmin } from '../../config.ts';

/** Bound slow database calls so one update cannot hold Telegram polling indefinitely. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after ' + timeoutMs + 'ms')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Saves user identity updates and filters blocked users before command handlers run. */
export function registerUserTrackingMiddleware(bot: Telegraf): void {
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      // One atomic RPC replaces the previous SELECT + UPSERT + blocked-status SELECT.
      let trackedUser: { is_new: boolean; is_blocked: boolean };
      try {
        trackedUser = await withTimeout(trackTelegramUser({
          id: ctx.from.id,
          username: ctx.from.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        });
      } catch (err) {
        console.error('[UserTracking] Database check failed; update was not processed:', err instanceof Error ? err.message : String(err));
        // Fail closed: without the database we cannot safely determine whether this
        // account is blocked. Tell the user to retry instead of silently ignoring them.
        try {
          await ctx.reply('⚠️ The service is temporarily unable to verify your account. Please try again in a moment.');
        } catch (replyError) {
          console.warn('[UserTracking] Could not send temporary-failure notice:', replyError instanceof Error ? replyError.message : String(replyError));
        }
        return;
      }

      if (trackedUser.is_new) {
        try {
          const channel = await getSetting<string>('notification_join_premium_channel', '');
          if (channel) {
            const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || 'Unknown';
            const username = ctx.from.username ? '@' + ctx.from.username : '—';
            await ctx.telegram.sendMessage(
              channel,
              '👤 <b>New user joined</b>\n\nName: ' + name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
              '\nUsername: ' + username.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
              '\nUser ID: <code>' + ctx.from.id + '</code>',
              { parse_mode: 'HTML' },
            );
          }
        } catch (err) {
          console.warn('[Notifications] New-user notification failed:', err instanceof Error ? err.message : String(err));
        }
      }

      if (trackedUser.is_blocked) return;
    }

    if (ctx.from && !isAdmin(ctx.from.id)) {
      const maintenance = await withTimeout(getSetting<boolean>('maintenance_mode', false), 5_000, 'Maintenance setting');
      if (maintenance) {
        try {
          await ctx.reply('⚠️ The bot is currently under maintenance. Please check back later.');
        } catch {}
        return;
      }
    }

    return next();
  });
}
