import { Telegraf } from 'telegraf';
import { getSupabase } from '../database/supabase.ts';
import { isAdmin } from '../config.ts';
import { getCached, invalidateCached } from './readCache.ts';
import { getSetting } from './settings.ts';

export interface ForceSubChannel {
  id: string;
  channel_id: string;
  title: string;
  invite_link: string | null;
  is_active: boolean;
  request_mode: boolean;
}

export interface ForceSubCheckResult {
  passed: boolean;
  missingChannels: ForceSubChannel[];
}

const FORCE_SUB_CHANNELS_CACHE_KEY = 'force-sub:active-channels';
const FORCE_SUB_CACHE_TTL_MS = 5_000;

export async function getActiveForceSubChannels(): Promise<ForceSubChannel[]> {
  return getCached(FORCE_SUB_CHANNELS_CACHE_KEY, FORCE_SUB_CACHE_TTL_MS, async () => {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('force_sub_channels')
      .select('*')
      .eq('is_active', true);

    if (error) throw new Error(`Failed fetching force-sub channels: ${error.message}`);
    return (data as ForceSubChannel[]) || [];
  });
}

export async function isForceSubGloballyEnabled(): Promise<boolean> {
  return getSetting<boolean>('force_sub_enabled', false);
}

export async function checkUserForceSub(
  bot: Telegraf,
  userId: number
): Promise<ForceSubCheckResult> {
  // Admins bypass force-sub check automatically
  if (isAdmin(userId)) {
    return { passed: true, missingChannels: [] };
  }

  const enabled = await isForceSubGloballyEnabled();
  if (!enabled) {
    return { passed: true, missingChannels: [] };
  }

  const channels = await getActiveForceSubChannels();
  if (channels.length === 0) {
    return { passed: true, missingChannels: [] };
  }

  const missing: ForceSubChannel[] = [];
  const concurrency = 5;

  // Configuration is cached briefly, but membership remains a live Telegram check.
  for (let offset = 0; offset < channels.length; offset += concurrency) {
    const batch = channels.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(async (ch) => {
      try {
        const member = await bot.telegram.getChatMember(ch.channel_id, userId);
        const isMember = member.status === 'creator' ||
          member.status === 'administrator' ||
          member.status === 'member' ||
          (member.status === 'restricted' && 'is_member' in member && Boolean(member.is_member));
        return isMember ? null : ch;
      } catch (err) {
        // An API/network failure is not proof that the user is unsubscribed.
        // Propagate it so the bot can report a temporary verification failure.
        console.warn(`Membership verification failed for user ${userId} in channel ${ch.channel_id}:`, err instanceof Error ? err.message : String(err));
        throw err;
      }
    }));
    for (const result of results) {
      if (result) missing.push(result);
    }
  }

  return { passed: missing.length === 0, missingChannels: missing };
}

export async function createForceSubInviteLink(
  bot: Telegraf,
  channelId: string,
  requestMode: boolean,
): Promise<{ title: string; inviteLink: string }> {
  const chat = await bot.telegram.getChat(channelId);
  const title = 'title' in chat ? String(chat.title || channelId) : channelId;
  const link = await bot.telegram.createChatInviteLink(channelId, {
    creates_join_request: requestMode,
  });
  return { title, inviteLink: link.invite_link };
}

export async function getAllForceSubChannels(): Promise<ForceSubChannel[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('force_sub_channels')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Failed fetching force-sub channels: ${error.message}`);
  return (data as ForceSubChannel[]) || [];
}

export async function upsertForceSubChannel(params: {
  channelId: string;
  title: string;
  inviteLink?: string | null;
  requestMode?: boolean;
  isActive?: boolean;
}): Promise<ForceSubChannel> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('force_sub_channels')
    .upsert({
      channel_id: params.channelId.trim(),
      chat_id: params.channelId.trim(),
      title: params.title.trim(),
      invite_link: params.inviteLink?.trim() || null,
      request_mode: Boolean(params.requestMode),
      is_active: params.isActive !== false,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'channel_id' })
    .select('*')
    .single();
  if (error) throw new Error(`Failed saving force-sub channel: ${error.message}`);
  invalidateCached(FORCE_SUB_CHANNELS_CACHE_KEY);
  return data as ForceSubChannel;
}

export async function updateForceSubChannel(
  id: string,
  updates: Partial<Pick<ForceSubChannel, 'title' | 'invite_link' | 'request_mode' | 'is_active'>>
): Promise<ForceSubChannel> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('force_sub_channels')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw new Error(`Failed updating force-sub channel: ${error.message}`);
  invalidateCached(FORCE_SUB_CHANNELS_CACHE_KEY);
  return data as ForceSubChannel;
}

export async function deleteForceSubChannel(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('force_sub_channels').delete().eq('id', id);
  if (error) throw new Error(`Failed deleting force-sub channel: ${error.message}`);
  invalidateCached(FORCE_SUB_CHANNELS_CACHE_KEY);
}
