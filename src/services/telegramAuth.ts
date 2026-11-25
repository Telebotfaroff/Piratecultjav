import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { getSupabase } from '../database/supabase.ts';

export type TelegramAuthAction = 'start' | 'code' | 'password' | 'cancel' | 'disconnect';
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_ENCRYPTION_KEY?.trim();
  if (!secret) throw new Error('SESSION_ENCRYPTION_KEY must be configured before Telegram account login.');
  return createHash('sha256').update(secret, 'utf8').digest();
}
function encryptPayload(payload: Record<string, unknown>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return JSON.stringify({ iv: iv.toString('base64'), ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64') });
}
export async function queueTelegramAuthAction(adminId: number, action: TelegramAuthAction, payload: Record<string, unknown> = {}): Promise<void> {
  const { error } = await getSupabase().from('telegram_auth_requests').insert({
    admin_telegram_id: adminId, action, encrypted_payload: encryptPayload(payload), status: 'queued',
  });
  if (error) throw new Error('Could not queue Telegram authentication action: ' + error.message);
}
export async function getTelegramAuthStatus(adminId: number): Promise<{
  connected: boolean;
  account: { telegram_user_id: number; username: string | null; first_name: string | null; phone_last4: string | null; connected_at: string } | null;
  request: { status: string; error: string | null; updated_at: string } | null;
}> {
  const supabase = getSupabase();
  const [accountResult, requestResult] = await Promise.all([
    supabase.from('telegram_user_sessions').select('telegram_user_id, username, first_name, phone_last4, connected_at').eq('id', 1).maybeSingle(),
    supabase.from('telegram_auth_requests').select('status, error, updated_at').eq('admin_telegram_id', adminId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (accountResult.error) throw new Error('Could not read Telegram account status: ' + accountResult.error.message);
  if (requestResult.error) throw new Error('Could not read Telegram login status: ' + requestResult.error.message);
  return {
    connected: Boolean(accountResult.data),
    account: accountResult.data ? {
      telegram_user_id: Number(accountResult.data.telegram_user_id), username: accountResult.data.username,
      first_name: accountResult.data.first_name, phone_last4: accountResult.data.phone_last4,
      connected_at: accountResult.data.connected_at,
    } : null,
    request: requestResult.data || null,
  };
}
