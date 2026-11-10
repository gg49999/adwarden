import type { Command, ComponentHandler } from "./core/command.js";
import { adCommands, adComponents } from "./modules/ads/commands.js";
import { reviewHandler } from "./modules/ads/review.js";
import { generalCommands } from "./modules/general/help.js";
import { moderationCommands } from "./modules/moderation/commands.js";
import { appealHandler } from "./modules/moderation/appeals.js";
import { reportCommands, reportHandler } from "./modules/moderation/reports.js";
import { roleCommands, roleBulkHandler, panelHandler } from "./modules/roles/commands.js";
import { configCommands } from "./modules/setup/config.js";
import { setupCommands, setupHandler } from "./modules/setup/setup.js";
import { stickyCommands, stickyComponents } from "./modules/sticky/commands.js";
import { rulesetCommands } from "./modules/ads/rulesetCommands.js";
import { settingsCommands, settingsHandler } from "./modules/setup/settings.js";

export const commands: Command[] = [
  ...setupCommands,
  ...settingsCommands,
  ...configCommands,
  ...generalCommands,
  ...adCommands,
  ...rulesetCommands,
  ...stickyCommands,
  ...moderationCommands,
  ...reportCommands,
  ...roleCommands,
];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));

export const componentHandlers = new Map<string, ComponentHandler>(
  [adComponents, reviewHandler, stickyComponents, appealHandler, reportHandler, roleBulkHandler, panelHandler, setupHandler, settingsHandler].map((h) => [h.prefix, h]),
);
