import { Telegraf } from 'telegraf';
import { config } from '../config.ts';
import { withTelegramRetry } from './telegramErrors.ts';

export interface SendToDumpResult {
  messageId: number;
  fileId?: string;
}

/**
 * Copies a stored video from the dump channel to a target Telegram user.
 * Optional Telegram copy options allow callers to attach caption formatting
 * and inline keyboards to the delivered message.
 */
export async function sendDumpVideoToUser(
  bot: Telegraf,
  targetChatId: number | string,
  dumpChatId: string | number,
  videoMessageId: number,
  caption?: string,
  copyOptions: Record<string, unknown> = {},
): Promise<boolean> {
  try {
    await withTelegramRetry(
      () => bot.telegram.copyMessage(targetChatId, dumpChatId, videoMessageId, { caption, ...copyOptions }),
      { label: `dump-copy:${dumpChatId}:${videoMessageId}` },
    );
    return true;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`Failed copying dump message ${videoMessageId} from ${dumpChatId} to ${targetChatId}:`, errorMsg);
    throw err;
  }
}

/**
 * Sends a thumbnail image to the dump channel to obtain a permanent Telegram file_id/message_id
 */
export async function storeThumbnailInDumpChannel(
  bot: Telegraf,
  thumbnailUrl: string,
  code: string
): Promise<SendToDumpResult | null> {
  try {
    const sent = await bot.telegram.sendPhoto(config.dumpChatId, thumbnailUrl, {
      caption: `[THUMBNAIL] ${code}`,
    });

    const photo = sent.photo && sent.photo.length > 0 ? sent.photo[sent.photo.length - 1] : null;

    return {
      messageId: sent.message_id,
      fileId: photo ? photo.file_id : undefined,
    };
  } catch (err) {
    console.warn(`Could not upload thumbnail to dump channel for ${code}:`, err);
    return null;
  }
}
