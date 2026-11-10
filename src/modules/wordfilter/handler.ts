import { EmbedBuilder, type Message } from "discord.js";
import { COLORS, codeBlock } from "../../core/embeds.js";
import { getConfig, type GuildConfig } from "../../core/guildConfig.js";
import { isStaff } from "../../core/permissions.js";
import { log } from "../../logger.js";
import { getAdRules } from "../ads/store.js";
import { botDelete, sendLog } from "../logging/logs.js";
import { createCase, notifyUser, warnMember } from "../moderation/service.js";
import { compiledFor, findWord } from "./filter.js";

/** Whether the filter applies to this channel (thread messages use their parent channel's settings). */
export function filterApplies(wf: GuildConfig["wordFilter"], channelId: string, parentId: string | null): boolean {
  const ids = [channelId, parentId].filter((x): x is string => !!x);
  if (ids.some((id) => wf.exemptChannelIds.includes(id))) return false;
  if (wf.scope === "ads") return ids.some((id) => !!getAdRules(id));
  if (wf.scope === "selected") return ids.some((id) => wf.channelIds.includes(id));
  return true;
}

export function matchFilter(cfg: GuildConfig, content: string): string | null {
  const wf = cfg.wordFilter;
  if (!wf.enabled || !wf.words.length) return null;
  return findWord(content, compiledFor("wf", wf.words), { leet: wf.leet, spacing: wf.spacing });
}

/** Returns true if the message was removed. */
export async function filterMessage(message: Message<true>, edited = false): Promise<boolean> {
  const cfg = await getConfig(message.guildId);
  const wf = cfg.wordFilter;
  if (!wf.enabled || !wf.words.length) return false;
  if (edited && !wf.checkEdits) return false;
  const parentId = message.channel.isThread() ? message.channel.parentId : null;
  if (!filterApplies(wf, message.channelId, parentId)) return false;
  if (wf.exemptStaff && isStaff(message.member)) return false;
  if (message.member && wf.exemptRoleIds.some((r) => message.member!.roles.cache.has(r))) return false;

  const hit = matchFilter(cfg, message.content);
  if (!hit) return false;

  const { guild, author } = message;
  const shown = hit.replace(/\*/g, "");
  let did = "logged";
  if (wf.action !== "log") {
    await botDelete(message).catch(() => {});
    did = "deleted";
  }
  const reason = `Filtered word (${shown})`;
  try {
    if (wf.action === "delete_warn" && message.member) {
      const w = await warnMember(guild, message.member, guild.client.user, reason);
      did += ` + warned (case #${w.case.number})${w.escalated ? ` + ${w.escalated}` : ""}`;
    } else if (wf.action === "delete_timeout" && message.member?.moderatable) {
      const ms = wf.timeoutMinutes * 60_000;
      await notifyUser(guild, author, "timeout", reason, ms);
      await message.member.timeout(ms, reason);
      await createCase({ guild, type: "timeout", user: author, mod: guild.client.user, reason, durationMs: ms });
      did += " + timed out";
    } else if (wf.action === "delete" && wf.dmUser) {
      await author
        .send({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.warn)
              .setTitle(`Your message in ${guild.name} was removed`)
              .setDescription(`It contained a word that isn't allowed there (||${shown}||).`)
              .addFields({ name: "Your message", value: codeBlock(message.content, 1000) }),
          ],
        })
        .catch(() => {});
    }
  } catch (err) {
    log.warn("Word filter action failed", err);
  }

  await sendLog(
    guild,
    "mod",
    new EmbedBuilder()
      .setColor(COLORS.warn)
      .setAuthor({ name: `Word filter: ${did}${edited ? " (edited message)" : ""}`, iconURL: author.displayAvatarURL() })
      .setDescription(`${author} in ${message.channel} · matched \`${hit}\``)
      .addFields({ name: "Content", value: codeBlock(message.content, 900) }),
  );
  return wf.action !== "log";
}
