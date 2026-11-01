import { getSupabase } from '../database/supabase.ts';
import { getSetting, setSetting } from './settings.ts';

export interface UserRecord {
  id: string;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_blocked: boolean;
  plan: 'free' | 'semi_premium' | 'premium';
  plan_expires_at: string | null;
  daily_download_count: number;
  daily_download_date: string;
  unlimited_until: string | null;
  referred_by: number | null;
  referral_reward_claimed: boolean;
  created_at?: string;
  updated_at?: string;
}

export async function upsertUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<UserRecord | null> {
  try {
    const supabase = getSupabase();
    const payload = {
      telegram_user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('users')
      .upsert(payload, { onConflict: 'telegram_user_id' })
      .select()
      .maybeSingle();

    if (error) {
      console.warn('Error upserting user:', error.message);
      return null;
    }

    return data as UserRecord;
  } catch {
    return null;
  }
}

export async function isUserBlocked(telegramUserId: number): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('is_blocked')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (error || !data) return false;
    return Boolean(data.is_blocked);
  } catch {
    return false;
  }
}

export async function setUserBlocked(telegramUserId: number, isBlocked: boolean): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('users')
    .update({ is_blocked: isBlocked, updated_at: new Date().toISOString() })
    .eq('telegram_user_id', telegramUserId);

  if (error) {
    throw new Error(`Failed updating blocked status: ${error.message}`);
  }

  return true;
}

export async function countUsers(): Promise<number> {
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}


export async function getBroadcastUserIds(): Promise<number[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('telegram_user_id')
    .eq('is_blocked', false);
  if (error) throw new Error(`Failed loading broadcast recipients: ${error.message}`);
  return (data || []).map(row => Number(row.telegram_user_id)).filter(Number.isFinite);
}


export interface DownloadQuotaSettings {
  free: number;
  semi_premium: number;
}

const DEFAULT_DOWNLOAD_QUOTAS: DownloadQuotaSettings = { free: 20, semi_premium: 40 };

export async function getDownloadQuotaSettings(): Promise<DownloadQuotaSettings> {
  // Cache only the configuration value; actual quota consumption remains atomic/live.
  const value = await getSetting<DownloadQuotaSettings>('download_quotas', DEFAULT_DOWNLOAD_QUOTAS);
  if (!value || typeof value !== 'object') return { ...DEFAULT_DOWNLOAD_QUOTAS };
  const free = Number(value.free);
  const semiPremium = Number(value.semi_premium);
  return {
    free: Number.isInteger(free) && free >= 0 ? free : DEFAULT_DOWNLOAD_QUOTAS.free,
    semi_premium: Number.isInteger(semiPremium) && semiPremium >= 0 ? semiPremium : DEFAULT_DOWNLOAD_QUOTAS.semi_premium,
  };
}

export async function setDownloadQuotaSettings(settings: DownloadQuotaSettings): Promise<void> {
  await setSetting('download_quotas', settings);
}

export interface DownloadAllowance {
  allowed: boolean;
  remaining: number;
  plan: 'free' | 'semi_premium' | 'premium';
  unlimited_until: string | null;
}

export async function getUser(telegramUserId: number): Promise<UserRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('users').select('*')
    .eq('telegram_user_id', telegramUserId).maybeSingle();
  if (error || !data) return null;
  return data as UserRecord;
}

export interface UserDashboard {
  plan: 'free' | 'semi_premium' | 'premium';
  plan_expires_at: string | null;
  unlimited_until: string | null;
  daily_limit: number;
  daily_used: number;
  daily_remaining: number;
  is_unlimited: boolean;
  referral_count: number;
  completed_referral_count: number;
  referred_by: number | null;
  referral_completed: boolean;
}

export interface ReferralLeaderboardEntry {
  telegram_user_id: number;
  display_name: string;
  completed_referrals: number;
  total_referrals: number;
}

export async function getReferralLeaderboard(limit = 10): Promise<ReferralLeaderboardEntry[]> {
  const safeLimit = Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 10, 1), 25);
  const { data, error } = await getSupabase().rpc('get_referral_leaderboard', {
    p_limit: safeLimit,
  });

  if (error) {
    throw new Error(`Failed loading referral leaderboard: ${error.message}`);
  }

  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> =>
    Boolean(row && typeof row === 'object')
  ).map(row => ({
    telegram_user_id: Number(row.telegram_user_id),
    display_name: String(row.display_name || 'User').slice(0, 40),
    completed_referrals: Number(row.completed_referrals || 0),
    total_referrals: Number(row.total_referrals || 0),
  })).filter(row => Number.isFinite(row.telegram_user_id));
}

export interface PremiumPaymentResult {
  success: boolean;
  message: string;
  plan_expires_at: string | null;
}

export async function completeStarPremiumPayment(input: {
  userId: number;
  payload: string;
  durationDays: number;
  amountStars: number;
  currency: string;
  telegramChargeId: string;
  providerChargeId?: string | null;
}): Promise<PremiumPaymentResult> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('complete_star_premium_payment', {
    p_user_id: input.userId,
    p_payload: input.payload,
    p_duration_days: input.durationDays,
    p_amount_stars: input.amountStars,
    p_currency: input.currency,
    p_telegram_charge_id: input.telegramChargeId,
    p_provider_charge_id: input.providerChargeId || null,
  });
  if (error) throw new Error(`Failed processing premium payment: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: Boolean(row?.success),
    message: String(row?.message || 'Payment could not be processed.'),
    plan_expires_at: row?.plan_expires_at || null,
  };
}

export interface PromoRedemptionResult {
  success: boolean;
  message: string;
  reward_type: 'plan' | 'unlimited' | null;
  reward_plan: 'semi_premium' | 'premium' | null;
  reward_days: number;
  expires_at: string | null;
}

export async function redeemPromoCode(userId: number, code: string): Promise<PromoRedemptionResult> {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,64}$/.test(normalizedCode)) {
    return {
      success: false,
      message: 'Promo code format is invalid. Use 3–64 letters, numbers, hyphens, or underscores.',
      reward_type: null,
      reward_plan: null,
      reward_days: 0,
      expires_at: null,
    };
  }
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('redeem_promo_code', {
    p_user_id: userId,
    p_code: normalizedCode,
  });
  if (error) throw new Error(`Failed redeeming promo: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    success: Boolean(row?.success),
    message: String(row?.message || 'Promo could not be redeemed.'),
    reward_type: row?.reward_type || null,
    reward_plan: row?.reward_plan || null,
    reward_days: Number(row?.reward_days || 0),
    expires_at: row?.expires_at || null,
  };
}

export interface PremiumPaymentAdminRecord {
  telegram_user_id: number;
  duration_days: number;
  amount_stars: number;
  currency: string;
  telegram_payment_charge_id: string;
  created_at: string;
}

export async function listPremiumPayments(limit = 20): Promise<PremiumPaymentAdminRecord[]> {
  const supabase = getSupabase();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const { data, error } = await supabase
    .from('premium_payments')
    .select('telegram_user_id,duration_days,amount_stars,currency,telegram_payment_charge_id,created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw new Error(`Failed loading Premium payments: ${error.message}`);
  return (data || []) as PremiumPaymentAdminRecord[];
}

export interface PromoAdminRecord {
  id: string;
  code: string;
  reward_type: 'plan' | 'unlimited';
  reward_plan: 'semi_premium' | 'premium' | null;
  reward_days: number;
  max_uses: number | null;
  used_count: number;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
}

export async function listPromoCodes(limit = 20): Promise<PromoAdminRecord[]> {
  const supabase = getSupabase();
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 50);
  const { data, error } = await supabase
    .from('promo_codes')
    .select('id,code,reward_type,reward_plan,reward_days,max_uses,used_count,expires_at,is_active,created_at')
    .order('created_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw new Error(`Failed loading promo codes: ${error.message}`);
  return (data || []) as PromoAdminRecord[];
}

export async function setPromoCodeActive(code: string, active: boolean): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('promo_codes')
    .update({ is_active: active })
    .eq('code', code.trim().toUpperCase())
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Failed updating promo code: ${error.message}`);
  return Boolean(data);
}

export async function createPromoCode(
  code: string,
  rewardType: 'plan' | 'unlimited',
  rewardPlan: 'semi_premium' | 'premium' | null,
  rewardDays: number,
  maxUses: number | null,
  expiresAt: string | null,
  createdBy: number,
): Promise<boolean> {
  const normalizedCode = code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,64}$/.test(normalizedCode)) {
    throw new Error('Promo code must be 3–64 characters using A–Z, 0–9, underscore, or hyphen.');
  }
  if (!Number.isInteger(rewardDays) || rewardDays < 1 || rewardDays > 3650) {
    throw new Error('Promo reward duration must be 1–3650 days.');
  }
  if (maxUses !== null && (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 1000000)) {
    throw new Error('Promo max uses must be 1–1,000,000 or null.');
  }
  if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())) {
    throw new Error('Promo expiry must be a future date/time.');
  }
  if ((rewardType === 'unlimited' && rewardPlan !== null) ||
      (rewardType === 'plan' && !['premium', 'semi_premium'].includes(String(rewardPlan)))) {
    throw new Error('Invalid promo reward configuration.');
  }

  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('create_promo_code', {
    p_code: normalizedCode,
    p_reward_type: rewardType,
    p_reward_plan: rewardPlan,
    p_reward_days: rewardDays,
    p_max_uses: maxUses,
    p_expires_at: expiresAt,
    p_created_by: createdBy,
  });
  if (error) throw new Error(`Failed creating promo: ${error.message}`);
  return Boolean(data);
}

export async function getUserDashboard(telegramUserId: number): Promise<UserDashboard | null> {
  const supabase = getSupabase();
  const { data: user, error } = await supabase
    .from('users')
    .select('plan,plan_expires_at,unlimited_until,daily_download_count,daily_download_date,referred_by,referral_completed')
    .eq('telegram_user_id', telegramUserId)
    .maybeSingle();

  if (error || !user) return null;

  const { count: referralCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('referred_by', telegramUserId);

  const { count: completedReferralCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true })
    .eq('referred_by', telegramUserId)
    .eq('referral_completed', true);

  const today = new Date().toISOString().slice(0, 10);
  const used = user.daily_download_date === today ? Number(user.daily_download_count || 0) : 0;
  const planExpires = user.plan_expires_at ? new Date(user.plan_expires_at) : null;
  const planActive = !planExpires || planExpires.getTime() > Date.now();
  const effectivePlan = planActive ? user.plan : 'free';
  const bonusActive = Boolean(user.unlimited_until && new Date(user.unlimited_until).getTime() > Date.now());
  const unlimited = effectivePlan === 'premium' || bonusActive;
  const quotas = await getDownloadQuotaSettings();
  const limit = unlimited ? -1 : effectivePlan === 'semi_premium' ? quotas.semi_premium : quotas.free;

  return {
    plan: effectivePlan,
    plan_expires_at: planActive ? user.plan_expires_at : null,
    unlimited_until: user.unlimited_until || null,
    daily_limit: limit,
    daily_used: used,
    daily_remaining: unlimited ? -1 : Math.max(limit - used, 0),
    is_unlimited: unlimited,
    referral_count: Number(referralCount || 0),
    completed_referral_count: Number(completedReferralCount || 0),
    referred_by: user.referred_by ? Number(user.referred_by) : null,
    referral_completed: Boolean(user.referral_completed),
  };
}

export async function trackTelegramUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<{ is_new: boolean; is_blocked: boolean }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('track_telegram_user', {
    p_telegram_user_id: user.id,
    p_username: user.username || null,
    p_first_name: user.first_name || null,
    p_last_name: user.last_name || null,
  });
  if (error) throw new Error(`Failed tracking Telegram user: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('User tracking returned no result.');
  return { is_new: Boolean(row.is_new), is_blocked: Boolean(row.is_blocked) };
}

export async function consumeVideoDownload(telegramUserId: number, reservationId: string): Promise<DownloadAllowance> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('consume_video_download_with_reservation', {
    p_user_id: telegramUserId,
    p_reservation_id: reservationId,
  });
  if (error) throw new Error(`Failed checking download allowance: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    remaining: Number(row?.remaining ?? 0),
    plan: (row?.plan || 'free') as DownloadAllowance['plan'],
    unlimited_until: row?.unlimited_until || null,
  };
}

export async function markVideoDownloadDelivered(reservationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('mark_video_download_delivered', { p_reservation_id: reservationId });
  if (error) throw new Error(`Failed marking download delivered: ${error.message}`);
  return Boolean(data);
}

export async function refundVideoDownload(telegramUserId: number, reservationId: string): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('refund_video_download', {
    p_user_id: telegramUserId,
    p_reservation_id: reservationId,
  });
  if (error) throw new Error(`Failed refunding download allowance: ${error.message}`);
  return Boolean(data);
}

export async function registerReferral(referrerId: number, referredId: number): Promise<{ success: boolean; unlimited_until: string | null }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('register_referral', {
    p_referrer: referrerId,
    p_referred: referredId,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      return { success: false, unlimited_until: null };
    }
    throw new Error(`Failed registering referral: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { success: Boolean(row?.success), unlimited_until: row?.unlimited_until || null };
}

export async function completeReferral(referredId: number): Promise<{ success: boolean; unlimited_until: string | null }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('complete_referral', {
    p_referred: referredId,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      return { success: false, unlimited_until: null };
    }
    throw new Error(`Failed completing referral: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { success: Boolean(row?.success), unlimited_until: row?.unlimited_until || null };
}

export async function setUserPlan(telegramUserId: number, plan: 'free' | 'semi_premium' | 'premium'): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('set_user_plan', {
    p_user_id: telegramUserId,
    p_plan: plan,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      // Fallback: direct column update if column exists, else return false
      const { error: updateError } = await supabase
        .from('users')
        .update({ plan, updated_at: new Date().toISOString() })
        .eq('telegram_user_id', telegramUserId);
      return !updateError;
    }
    throw new Error(`Failed setting user plan: ${error.message}`);
  }
  return Boolean(data);
}
