# Multi-Delivery Bot Manager

PiratecultJAV supports multiple saved Telegram delivery bots with **manual active-bot selection**.

## Runtime model

- The controller bot remains separate and owns the admin interface.
- Any number of delivery bot credentials can be saved in the existing `bot_settings` table.
- Exactly one delivery bot is selected as active at a time.
- Only the selected delivery bot receives user updates and handles user-facing commands.
- Switching the active bot restarts the existing Telegram runtime using the selected token. No round-robin routing or automatic delivery failover is performed.
- The existing `delivery_bot_token` setting is kept synchronized with the selected bot for compatibility with existing startup code and deployments.

This first implementation deliberately reuses the current Telegraf handler registration and lifecycle. It does not create parallel polling loops or duplicate controller handlers.

## Admin commands

Add another bot:

```text
/adddeliverybot Bot Name | BOT_TOKEN
```

Replace the currently selected bot:

```text
/setdeliverybot BOT_TOKEN
```

The command message is deleted after it is received. Tokens are never rendered in the manager UI or confirmation messages.

## Admin panel

Open **Admin Center → Delivery Bot Manager** to:

- See the configured bot list and currently selected bot.
- Select a different bot.
- Add a bot using the guided command.
- Remove a bot after confirmation.
- Refresh the runtime status.

## Bot setup checklist

For each delivery bot:

1. Create the bot with @BotFather.
2. Add it through `/adddeliverybot`.
3. Add the bot to the dump/storage channel with permission to access and send the stored media.
4. Add it to any force-subscription channels where its membership checks or invite operations are required.
5. Select it in Delivery Bot Manager and confirm the runtime returns online.

## Backward compatibility

Existing installations with only `delivery_bot_token` are automatically displayed as **Delivery Bot 1**. No database migration is required. The legacy setting is retained and updated whenever the selected bot changes.
