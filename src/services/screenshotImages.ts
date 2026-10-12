import { getSupabase } from '../database/supabase.ts';

export interface ScreenshotImage {
  id: string;
  code: string;
  normalized_code: string;
  channel_id: string;
  message_id: number;
  file_id: string;
  width: number | null;
  height: number | null;
  created_at: string;
}

export async function saveScreenshotImage(input: {
  code: string;
  normalizedCode: string;
  channelId: string;
  messageId: number;
  fileId: string;
  width?: number;
  height?: number;
}): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase.from('screenshot_images').upsert({
    code: input.code,
    normalized_code: input.normalizedCode,
    channel_id: input.channelId,
    message_id: input.messageId,
    file_id: input.fileId,
    width: input.width ?? null,
    height: input.height ?? null,
  }, { onConflict: 'channel_id,message_id', ignoreDuplicates: true });

  if (error) throw new Error('Could not save screenshot image: ' + error.message);
  return true;
}

export async function getScreenshotImagesByCode(code: string, limit = 60): Promise<ScreenshotImage[]> {
  const supabase = getSupabase();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  const { data, error } = await supabase
    .from('screenshot_images')
    .select('id,code,normalized_code,channel_id,message_id,file_id,width,height,created_at')
    .eq('normalized_code', code)
    .order('created_at', { ascending: true })
    .limit(safeLimit);

  if (error) throw new Error('Could not load screenshot images: ' + error.message);
  return (data || []) as ScreenshotImage[];
}

export async function getScreenshotImageById(id: string): Promise<ScreenshotImage | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return null;
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('screenshot_images')
    .select('id,code,normalized_code,channel_id,message_id,file_id,width,height,created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error('Could not load screenshot image: ' + error.message);
  return (data as ScreenshotImage) || null;
}
