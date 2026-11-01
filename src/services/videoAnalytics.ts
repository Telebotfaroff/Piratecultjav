import { getSupabase } from '../database/supabase.ts';

export type VideoDeliveryEventType =
  | 'attempt'
  | 'delivered'
  | 'force_sub_block'
  | 'limit_block'
  | 'not_found'
  | 'unavailable'
  | 'delivery_failed';

export async function recordVideoDeliveryEvent(params: {
  eventType: VideoDeliveryEventType;
  telegramUserId?: number | null;
  videoId?: string | null;
  code?: string | null;
  source?: 'deep_link' | 'search' | 'callback' | 'unknown';
  success?: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const { error } = await getSupabase().from('video_delivery_events').insert({
      event_type: params.eventType,
      telegram_user_id: params.telegramUserId ?? null,
      video_id: params.videoId ?? null,
      code: params.code ?? null,
      source: params.source ?? 'unknown',
      success: Boolean(params.success),
      error_message: params.errorMessage?.slice(0, 500) || null,
    });
    if (error) console.warn('[Analytics] Failed to record event:', error.message);
  } catch (error) {
    console.warn('[Analytics] Failed to record event:', error instanceof Error ? error.message : String(error));
  }
}

export async function getVideoDeliveryAnalytics(hours = 24): Promise<{
  attempts: number;
  delivered: number;
  forceSubBlocks: number;
  limitBlocks: number;
  failures: number;
  uniqueUsers: number;
  topVideos: Array<{ code: string; deliveries: number }>;
}> {
  const safeHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 168) : 24;
  const since = new Date(Date.now() - safeHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase().rpc('get_video_delivery_analytics', {
    p_since: since,
  });

  if (error) {
    throw new Error('Failed fetching delivery analytics: ' + error.message);
  }

  const result = data as {
    attempts?: number;
    delivered?: number;
    forceSubBlocks?: number;
    limitBlocks?: number;
    failures?: number;
    uniqueUsers?: number;
    topVideos?: Array<{ code: string; deliveries: number }>;
  } | null;

  if (!result || typeof result !== 'object') {
    throw new Error('Delivery analytics returned an invalid result.');
  }

  return {
    attempts: Number(result.attempts || 0),
    delivered: Number(result.delivered || 0),
    forceSubBlocks: Number(result.forceSubBlocks || 0),
    limitBlocks: Number(result.limitBlocks || 0),
    failures: Number(result.failures || 0),
    uniqueUsers: Number(result.uniqueUsers || 0),
    topVideos: Array.isArray(result.topVideos)
      ? result.topVideos.filter(item => item && typeof item.code === 'string')
        .map(item => ({ code: item.code, deliveries: Number(item.deliveries || 0) }))
      : [],
  };
}
