import { DiscordAPIError, type Interaction } from "discord.js";
import { log } from "../logger.js";
import { commandMap, componentHandlers } from "../registry.js";
import { replyErr, UserError } from "./reply.js";

export async function handleInteraction(i: Interaction) {
  try {
    if (i.isChatInputCommand()) {
      const cmd = commandMap.get(i.commandName);
      if (!cmd) return;
      await cmd.execute(i);
      return;
    }
    if (i.isAutocomplete()) {
      await commandMap.get(i.commandName)?.autocomplete?.(i);
      return;
    }
    if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
      const [prefix, ...args] = i.customId.split(":");
      await componentHandlers.get(prefix)?.handle(i, args);
    }
  } catch (err) {
    if (i.isAutocomplete() || !i.isRepliable()) return;
    if (err instanceof UserError) {
      await replyErr(i, err.message).catch(() => {});
      return;
    }
    let text = "Something went wrong. The error was logged.";
    if (err instanceof DiscordAPIError) {
      if (err.code === 50013) text = "I'm missing a permission for that. Check my role's permissions and that my role is high enough.";
      else if (err.code === 50001) text = "I can't access that channel.";
      else text = `Discord rejected that: ${err.message}`;
    }
    log.error(`Interaction failed (${i.isChatInputCommand() ? `/${i.commandName}` : "component" in i ? "component" : i.type})`, err);
    await replyErr(i, text).catch(() => {});
  }
}
