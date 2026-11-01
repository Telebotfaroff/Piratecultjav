import { getSupabase } from '../database/supabase.ts';
import { getCached, invalidateCached } from './readCache.ts';

const SETTING_CACHE_TTL_MS = 5_000;

export async function getSetting<T = unknown>(key: string, defaultValue: T): Promise<T> {
  try {
    return await getCached<T>(`setting:${key}`, SETTING_CACHE_TTL_MS, async () => {
      const supabase = getSupabase();
      const { data, error } = await supabase
        .from('bot_settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();

      if (error || !data) return defaultValue;
      const value = data.value;
      if (typeof defaultValue === 'boolean') {
        if (typeof value === 'boolean') return value as T;
        if (typeof value === 'string') {
          return (/^true$/i.test(value.trim()) ? true : /^false$/i.test(value.trim()) ? false : defaultValue) as T;
        }
      }
      return (value as T) ?? defaultValue;
    });
  } catch {
    return defaultValue;
  }
}

export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('bot_settings')
    .upsert(
      { key, value: value as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    throw new Error(`Failed saving setting ${key}: ${error.message}`);
  }
  invalidateCached(`setting:${key}`);
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('bot_settings').select('*');
    if (error || !data) return {};

    const settingsMap: Record<string, unknown> = {};
    for (const item of data) {
      settingsMap[item.key] = item.value;
    }
    return settingsMap;
  } catch {
    return {};
  }
}
