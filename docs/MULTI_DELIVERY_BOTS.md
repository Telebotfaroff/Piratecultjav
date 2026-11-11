# Multi-Delivery Bot Manager (V2)

V2 supports multiple saved Telegram delivery bots with manual active-bot selection.

## Runtime behavior

- The controller bot remains separate and continues to own the admin interface.
- Delivery bot configurations are stored in the existing `bot_settings` table under `delivery_bots`.
- Exactly one delivery bot is selected at a time.
- Only the selected bot receives user-facing updates and handles video delivery.
- Switching bots updates the legacy `delivery_bot_token` setting and restarts the existing V2 runtime.
- No round-robin routing, concurrent delivery polling, or automatic delivery failover is introduced.

## Admin controls

Open **Admin → Delivery Bot Manager** to view configured bots, select one, add another, remove a bot after confirmation, refresh status, or restart the selected bot.

You can also add a bot with:

```text
/adddeliverybot Bot Name | BOT_TOKEN
```

The existing command remains available to replace the currently selected bot:

```text
/setdeliverybot BOT_TOKEN
```

The interactive Add Delivery Bot flow also remains available from the manager. The token message is deleted after receipt and tokens are never rendered in the panel.

## Existing installations

An installation that only has `delivery_bot_token` is exposed as a virtual `Delivery Bot 1` entry. The first registry write persists that bot into the multi-bot list. No database migration is required.

## Setup

For each bot, create it with @BotFather, add it in the manager, grant it access to the dump/storage channel, and configure any channel permissions required by the bot's user-facing features. Then select it in the manager.
