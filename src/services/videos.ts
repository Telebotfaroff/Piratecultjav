import { getSupabase } from '../database/supabase.ts';
import { normalizeCode, cleanActressList } from './code.ts';
import { JavMetadata } from '../providers/javtiful/parser.ts';

export interface VideoRecord {
  id: string;
  code: string;
  normalized_code: string;
  title: string;
  description: string | null;
  provider: string;
  thumbnail_file_id: string | null;
  thumbnail_message_id: number | null;
  dump_chat_id: string;
  video_message_id: number;
  status: 'pending' | 'available' | 'failed' | 'disabled';
  metadata: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

export type PublicVideoRecord = Omit<VideoRecord, 'dump_chat_id' | 'video_message_id' | 'thumbnail_file_id'>;

export function toPublicVideo(video: VideoRecord): PublicVideoRecord {
  const { dump_chat_id: _dumpChatId, video_message_id: _videoMessageId, thumbnail_file_id: _thumbnailFileId, ...publicVideo } = video;
  return publicVideo;
}

export async function searchVideos(query: string, limit = 24, offset = 0, includeTotal = true): Promise<{ videos: VideoRecord[]; total: number }> {
  const supabase = getSupabase();
  const trimmed = query.trim();
  const normalized = normalizeCode(trimmed);

  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 24, 1), 100);
  const safeOffset = Math.max(Number.isFinite(offset) ? Math.floor(offset) : 0, 0);

  let dbQuery = supabase
    .from('videos')
    .select('*', includeTotal ? { count: 'exact' } : {})
    .eq('status', 'available');

  if (normalized) {
    // Code searches are normalized, so ABW001 / ABW-001 / ABW 001 / ABW_001
    // all resolve to the same canonical code.
    dbQuery = dbQuery.ilike('normalized_code', '%' + normalized + '%');
  } else if (trimmed) {
    // Search the denormalized search_text field so title, description, actress,
    // studio and genre metadata are searchable from the same input.
    const searchTerm = trimmed.replace(/[%_]/g, '\\$&');
    dbQuery = dbQuery.ilike('search_text', '%' + searchTerm + '%');
  }

  const { data, count, error } = await dbQuery
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (error) {
    throw new Error('Database error searching videos: ' + error.message);
  }

  return {
    videos: (data as VideoRecord[]) || [],
    total: includeTotal ? (count || 0) : 0,
  };
}

export async function getVideoByCode(code: string): Promise<VideoRecord | null> {
  const supabase = getSupabase();
  const norm = normalizeCode(code) || code.trim().toUpperCase();

  const { data, error } = await supabase
    .from('videos')
    .select('*')
    .eq('normalized_code', norm)
    .maybeSingle();

  if (error) throw new Error('Database error fetching video by code: ' + error.message);
  return (data as VideoRecord) || null;
}

export async function getVideoById(id: string): Promise<VideoRecord | null> {
  // The videos.id column is PostgreSQL UUID.
  const normalizedId = String(id).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedId)) return null;

  const supabase = getSupabase();
  const { data, error } = await supabase.from('videos').select('*').eq('id', normalizedId).maybeSingle();

  if (error) throw new Error('Database error fetching video by id: ' + error.message);
  return (data as VideoRecord) || null;
}

export interface UpsertVideoParams {
  code: string;
  dump_chat_id: string;
  video_message_id: number;
  metadata?: JavMetadata;
  thumbnail_file_id?: string | null;
  thumbnail_message_id?: number | null;
  status?: 'pending' | 'available' | 'failed' | 'disabled';
}

export async function upsertVideoFromProvider(params: UpsertVideoParams): Promise<VideoRecord> {
  const supabase = getSupabase();
  const norm = normalizeCode(params.code) || params.code.trim().toUpperCase();

  const record = {
    code: params.code,
    normalized_code: norm,
    title: params.metadata?.title || (norm + ' Video'),
    description: params.metadata?.description || null,
    provider: 'javtiful',
    thumbnail_file_id: params.thumbnail_file_id || null,
    thumbnail_message_id: params.thumbnail_message_id || null,
    dump_chat_id: params.dump_chat_id,
    video_message_id: params.video_message_id,
    status: params.status || 'available',
    metadata: {
      duration: params.metadata?.duration || null,
      date: params.metadata?.date || null,
      actresses: cleanActressList(params.metadata?.actresses),
      studio: params.metadata?.studio || null,
      genres: params.metadata?.genres || [],
      sourceUrl: params.metadata?.sourceUrl || null,
      thumbnailUrl: params.metadata?.thumbnailUrl || null,
    },
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from('videos').upsert(record, { onConflict: 'normalized_code' }).select().single();
  if (error) throw new Error('Database error upserting video: ' + error.message);
  return data as VideoRecord;
}

export async function listVideosWithoutThumbnail(
  limit = 20,
  offset = 0,
): Promise<{ videos: Pick<VideoRecord, 'id' | 'code' | 'title'>[]; total: number }> {
  const supabase = getSupabase();
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 20, 1), 1000);
  const safeOffset = Math.max(Number.isFinite(offset) ? Math.floor(offset) : 0, 0);
  const { data, count, error } = await supabase
    .from('videos')
    .select('id, code, title', { count: 'exact' })
    .or('thumbnail_file_id.is.null,thumbnail_file_id.eq.')
    .order('code', { ascending: true })
    .range(safeOffset, safeOffset + safeLimit - 1);

  if (error) throw new Error('Database error listing videos without thumbnails: ' + error.message);
  return {
    videos: (data || []) as Pick<VideoRecord, 'id' | 'code' | 'title'>[],
    total: count || 0,
  };
}

export async function getRecentVideos(limit = 20): Promise<VideoRecord[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('videos').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error('Database error fetching recent videos: ' + error.message);
  return (data as VideoRecord[]) || [];
}

export async function countVideos(): Promise<number> {
  const supabase = getSupabase();
  const { count, error } = await supabase.from('videos').select('*', { count: 'exact', head: true });
  if (error) return 0;
  return count || 0;
}


export async function updateVideoThumbnailByCode(
  code: string,
  thumbnailFileId: string,
  thumbnailMessageId: number,
): Promise<void> {
  const supabase = getSupabase();
  const normalized = normalizeCode(code) || code.trim().toUpperCase();
  const { data, error } = await supabase
    .from('videos')
    .update({
      thumbnail_file_id: thumbnailFileId,
      thumbnail_message_id: thumbnailMessageId,
      // A missing-metadata job leaves a placeholder row with status='failed'.
      // Once an admin supplies its thumbnail, the indexed dump message is usable
      // and must become searchable in the public catalog.
      status: 'available',
      updated_at: new Date().toISOString(),
    })
    .eq('normalized_code', normalized)
    .select('id')
    .maybeSingle();

  if (error) throw new Error('Database error updating video thumbnail: ' + error.message);
  if (!data) throw new Error(`No video catalog record exists for ${code}. The thumbnail was not linked.`);
}

export async function updateVideoMetadata(
  id: string,
  updates: {
    title?: string;
    description?: string | null;
    duration?: string | null;
    date?: string | null;
    actresses?: string[];
    studio?: string | null;
    genres?: string[];
  }
): Promise<VideoRecord> {
  const supabase = getSupabase();
  const current = await getVideoById(id);
  if (!current) throw new Error('Video record not found.');

  const currentMetadata = current.metadata || {};
  const nextMetadata = {
    ...currentMetadata,
    ...(updates.duration !== undefined ? { duration: updates.duration } : {}),
    ...(updates.date !== undefined ? { date: updates.date } : {}),
    ...(updates.actresses !== undefined ? { actresses: cleanActressList(updates.actresses) } : {}),
    ...(updates.studio !== undefined ? { studio: updates.studio } : {}),
    ...(updates.genres !== undefined ? { genres: updates.genres } : {}),
  };

  const payload: Record<string, unknown> = {
    metadata: nextMetadata,
    updated_at: new Date().toISOString(),
  };

  if (updates.title !== undefined) payload.title = updates.title;
  if (updates.description !== undefined) payload.description = updates.description;

  const { data, error } = await supabase
    .from('videos')
    .update(payload)
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error('Database error updating video: ' + error.message);
  return data as VideoRecord;
}

export async function deleteVideo(id: string): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('videos').delete().eq('id', id);
  if (error) throw new Error('Database error deleting video: ' + error.message);
}

export async function updateVideoStatus(id: string, status: 'available' | 'disabled'): Promise<VideoRecord> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('videos')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw new Error('Database error updating video status: ' + error.message);
  return data as VideoRecord;
}

