import { getSetting, setSetting } from './settings.ts';

export interface DeliveryBotConfig {
  id: string;
  name: string;
  username: string;
  token: string;
  addedAt: string;
}

const BOTS_KEY = 'delivery_bots';
const ACTIVE_BOT_KEY = 'active_delivery_bot_id';

/**
 * Returns configured delivery bots. The legacy single-token setting is exposed
 * as a virtual first bot so existing installations keep working after upgrade.
 */
export async function getDeliveryBots(): Promise<DeliveryBotConfig[]> {
  const stored = await getSetting<DeliveryBotConfig[]>(BOTS_KEY, []);
  const bots = Array.isArray(stored) ? stored.filter((bot) =>
    bot && typeof bot.id === 'string' && typeof bot.token === 'string'
  ) : [];

  if (bots.length) return bots;

  const legacyToken = await getSetting<string>('delivery_bot_token', '');
  if (!legacyToken) return [];
  return [{
    id: 'legacy',
    name: 'Delivery Bot 1',
    username: '',
    token: legacyToken,
    addedAt: new Date(0).toISOString(),
  }];
}

export async function getActiveDeliveryBotId(): Promise<string | null> {
  const bots = await getDeliveryBots();
  if (!bots.length) return null;
  const selected = await getSetting<string>(ACTIVE_BOT_KEY, '');
  return bots.some((bot) => bot.id === selected) ? selected : bots[0].id;
}

export async function getActiveDeliveryBot(): Promise<DeliveryBotConfig | null> {
  const bots = await getDeliveryBots();
  if (!bots.length) return null;
  const activeId = await getActiveDeliveryBotId();
  return bots.find((bot) => bot.id === activeId) || bots[0];
}

async function persistBots(bots: DeliveryBotConfig[], activeId: string | null): Promise<void> {
  await setSetting(BOTS_KEY, bots);
  await setSetting(ACTIVE_BOT_KEY, activeId || '');
  const active = bots.find((bot) => bot.id === activeId);
  // Keep the old key in sync for compatibility with existing runtime code.
  await setSetting('delivery_bot_token', active?.token || '');
}

export async function addDeliveryBot(bot: Omit<DeliveryBotConfig, 'addedAt'>): Promise<void> {
  const bots = await getDeliveryBots();
  if (bots.some((item) => item.id === bot.id)) {
    throw new Error('This Telegram bot is already registered.');
  }
  const next = [...bots, { ...bot, addedAt: new Date().toISOString() }];
  const activeId = await getActiveDeliveryBotId() || bot.id;
  await persistBots(next, activeId);
}

export async function selectDeliveryBot(id: string): Promise<DeliveryBotConfig> {
  const bots = await getDeliveryBots();
  const selected = bots.find((bot) => bot.id === id);
  if (!selected) throw new Error('Delivery bot not found.');
  await persistBots(bots, id);
  return selected;
}

export async function replaceActiveDeliveryBot(bot: Omit<DeliveryBotConfig, 'addedAt'>): Promise<void> {
  const bots = await getDeliveryBots();
  const activeId = await getActiveDeliveryBotId();
  const existing = bots.find((item) => item.id === activeId);
  if (!existing) {
    await persistBots([{ ...bot, addedAt: new Date().toISOString() }], bot.id);
    return;
  }
  if (bots.some((item) => item.id === bot.id && item.id !== existing.id)) {
    throw new Error('This Telegram bot is already registered.');
  }
  const next = bots.map((item) => item.id === existing.id
    ? { ...bot, addedAt: existing.addedAt }
    : item);
  await persistBots(next, bot.id);
}

export async function removeDeliveryBot(id: string): Promise<{ removed: DeliveryBotConfig; active: DeliveryBotConfig | null }> {
  const bots = await getDeliveryBots();
  const removed = bots.find((bot) => bot.id === id);
  if (!removed) throw new Error('Delivery bot not found.');
  const next = bots.filter((bot) => bot.id !== id);
  const currentActive = await getActiveDeliveryBotId();
  const nextActiveId = currentActive === id ? (next[0]?.id || null) : currentActive;
  await persistBots(next, nextActiveId);
  return { removed, active: next.find((bot) => bot.id === nextActiveId) || null };
}
