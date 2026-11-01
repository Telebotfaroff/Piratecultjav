import { Telegraf } from 'telegraf';
import { trackTelegramUser } from '../../services/users.ts';
import { getSetting } from '../../services/settings.ts';

/** Saves user identity updates and filters blocked users before command handlers run. */
export function registerUserTrackingMiddleware(bot: Telegraf): void {
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      // One atomic RPC replaces the previous SELECT + UPSERT + blocked-status SELECT.
      let trackedUser: { is_new: boolean; is_blocked: boolean };
      try {
        trackedUser = await trackTelegramUser({
          id: ctx.from.id,
          username: ctx.from.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        });
      } catch (err) {
        console.error('[UserTracking] Database check failed; update skipped:', err instanceof Error ? err.message : String(err));
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

    return next();
  });
}
