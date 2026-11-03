# Split Bot Architecture Plan

To split the bot into a main/controller bot and a delivery/public bot, we will modify the application to initialize two separate Telegraf instances, each configured with its own token (`BOT_TOKEN` / `DELIVERY_BOT_TOKEN`) and distinct sets of handlers.

1. **Configuration (`src/config.ts`)**:
   - Add `deliveryBotToken: process.env.DELIVERY_BOT_TOKEN || ''` to the configuration.
   - Update config validation to warn if `DELIVERY_BOT_TOKEN` is missing.

2. **Bot Initialization (`src/bot/index.ts`)**:
   - Change `let botInstance: Telegraf | null` to support two bots (e.g. `let controllerBotInstance`, `let deliveryBotInstance`).
   - Create `startControllerBot` and `startDeliveryBot` functions.
   - Register only admin and indexing-related command/action handlers (e.g., `dashboard`, `admin`, `settings`, channel_post dump parsing, screenshot parsing) on the **Controller Bot**.
   - Register only public-facing commands and callbacks (e.g., `start`, `help`, `search`, `premium`, `download`) on the **Delivery Bot**.
   - The User Tracking middleware will be applied to both, but it might need to know which bot triggered it, or both bots will just track users in the same central DB.

3. **Routing Output (`src/bot/helpers.ts`, `src/services/dump.ts`, etc.)**:
   - Instead of a global `getBot()` returning one bot, provide `getControllerBot()` and `getDeliveryBot()`.
   - Update logic that sends videos to users (`deliverVideoToUser`) to explicitly use the `getDeliveryBot()`.
   - Update logic that parses dumps or sends admin broadcasts to use `getControllerBot()`.

This is a significant architectural change that breaks the current fallback logic (`backupBotToken`) which was built for a single active bot.
