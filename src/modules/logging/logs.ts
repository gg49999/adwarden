import type { EmbedBuilder, Guild, MessageCreateOptions } from "discord.js";
import { getConfig } from "../../core/guildConfig.js";
import { log } from "../../logger.js";

export type LogKind = "mod" | "ads" | "messages" | "members";

/**
 * Posts to the configured log channel for `kind`. Falls back to the mod log for
 * ad logs when no ad log is set. Never throws.
 */
export async function sendLog(guild: Guild, kind: LogKind, embed: EmbedBuilder, extra: MessageCreateOptions = {}) {
  try {
    const cfg = await getConfig(guild.id);
    if (!cfg.modules.logging && kind !== "mod" && kind !== "ads") return;
    const channelId = cfg.logChannels[kind] ?? (kind === "ads" ? cfg.logChannels.mod : undefined);
    if (!channelId) return;
    const channel = guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
    if (!channel?.isTextBased()) return;
    if (!embed.data.timestamp) embed.setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] }, ...extra });
  } catch (err) {
    log.warn(`Failed to send ${kind} log in ${guild.id}`, err);
  }
}

/** Message IDs the bot removed itself, so the delete log doesn't double-report them. */
const botDeleted = new Set<string>();
export const wasBotDeleted = (id: string) => botDeleted.delete(id);

/** Deletes a message and suppresses its "message deleted" log entry. */
export function botDelete(message: { id: string; delete(): Promise<unknown> }) {
  botDeleted.add(message.id);
  setTimeout(() => botDeleted.delete(message.id), 60_000);
  return message.delete();
}
