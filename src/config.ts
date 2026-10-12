import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  botToken: string;
  backupBotToken: string;
  activeBot: 'primary' | 'backup';
  supabaseUrl: string;
  supabaseSecretKey: string;
  dumpChatId: string;
  screenshotChatId: string;
  adminIds: number[];
  javtifulBaseUrl: string;
  port: number;
  webhookUrl: string;
  webhookSecret: string;
  webhookPath: string;
  adminApiKey: string;
  adminSessionTtlMs: number;
  premium7Stars: number;
  premium30Stars: number;
  premium90Stars: number;
}

const rawAdminIds = process.env.ADMIN_IDS || '';
const adminIds: number[] = rawAdminIds
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(id => parseInt(id, 10))
  .filter(id => !isNaN(id));

export const config: AppConfig = {
  botToken: process.env.BOT_TOKEN || '',
  backupBotToken: process.env.BACKUP_BOT_TOKEN || '',
  activeBot: process.env.ACTIVE_BOT === 'backup' ? 'backup' : 'primary',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  dumpChatId: process.env.DUMP_CHAT_ID || '-1004426377644',
  screenshotChatId: process.env.SCREENSHOT_CHANNEL_ID || '',
  adminIds,
  javtifulBaseUrl: (process.env.JAVTIFUL_BASE_URL || 'https://javtiful.com').replace(/\/$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
  webhookUrl: (process.env.WEBHOOK_URL || '').replace(/\/$/, ''),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  webhookPath: (() => { const value = process.env.WEBHOOK_PATH || '/telegram-webhook'; return value.startsWith('/') ? value : `/${value}`; })(),
  adminApiKey: process.env.ADMIN_API_KEY || '',
  adminSessionTtlMs: 12 * 60 * 60 * 1000,
  premium7Stars: parseInt(process.env.PREMIUM_7_STARS || '50', 10),
  premium30Stars: parseInt(process.env.PREMIUM_30_STARS || '150', 10),
  premium90Stars: parseInt(process.env.PREMIUM_90_STARS || '350', 10),
};

export function isAdmin(telegramUserId: number | undefined): boolean {
  if (!telegramUserId) return false;
  return config.adminIds.includes(telegramUserId);
}

export interface ConfigValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export function validateConfig(): ConfigValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL');
  }
  if (!config.supabaseSecretKey) {
    missing.push('SUPABASE_SECRET_KEY');
  }
  if (!config.botToken && !config.backupBotToken) {
    warnings.push('BOT_TOKEN / BACKUP_BOT_TOKEN (No Telegram bot token configured)');
  } else if (!config.botToken) {
    warnings.push('BOT_TOKEN (Primary bot token is missing; backup will be used)');
  } else if (!config.backupBotToken) {
    warnings.push('BACKUP_BOT_TOKEN (No automatic bot recovery configured)');
  }
  if (config.adminIds.length === 0) {
    warnings.push('ADMIN_IDS (No admin IDs configured)');
  }
  if (!config.dumpChatId) {
    warnings.push('DUMP_CHAT_ID (Defaulting to -1004426377644)');
  }
  if (!config.adminApiKey) {
    missing.push('ADMIN_API_KEY');
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}
