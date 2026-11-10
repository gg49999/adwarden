import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Guild,
  type GuildMember,
  type User,
} from "discord.js";
import { db } from "../../db.js";
import { COLORS } from "../../core/embeds.js";
import { formatDuration, MAX_TIMEOUT_MS } from "../../core/duration.js";
import { getConfig } from "../../core/guildConfig.js";
import { log } from "../../logger.js";
import { sendLog } from "../logging/logs.js";

export type CaseType =
  | "warn" | "timeout" | "untimeout" | "kick" | "ban" | "tempban" | "softban" | "unban" | "note" | "adban" | "adunban";

const TYPE_STYLE: Record<CaseType, { label: string; color: number; emoji: string; verb: string }> = {
  warn: { label: "Warn", color: COLORS.warn, emoji: "⚠️", verb: "warned" },
  timeout: { label: "Timeout", color: COLORS.warn, emoji: "⏳", verb: "timed out" },
  untimeout: { label: "Timeout removed", color: COLORS.ok, emoji: "✅", verb: "had their timeout removed" },
  kick: { label: "Kick", color: COLORS.danger, emoji: "👢", verb: "kicked" },
  ban: { label: "Ban", color: COLORS.danger, emoji: "🔨", verb: "banned" },
  tempban: { label: "Temp ban", color: COLORS.danger, emoji: "🔨", verb: "temporarily banned" },
  softban: { label: "Softban", color: COLORS.danger, emoji: "🧹", verb: "softbanned" },
  unban: { label: "Unban", color: COLORS.ok, emoji: "🔓", verb: "unbanned" },
  note: { label: "Note", color: COLORS.muted, emoji: "📝", verb: "noted" },
  adban: { label: "Ad ban", color: COLORS.warn, emoji: "🚫", verb: "banned from advertising" },
  adunban: { label: "Ad ban lifted", color: COLORS.ok, emoji: "📢", verb: "allowed to advertise again" },
};

export const caseLabel = (t: string) => TYPE_STYLE[t as CaseType]?.label ?? t;

export async function nextCaseNumber(guildId: string): Promise<number> {
  const g = await db.guild.upsert({
    where: { id: guildId },
    create: { id: guildId, caseCounter: 1 },
    update: { caseCounter: { increment: 1 } },
  });
  return g.caseCounter;
}

interface CaseInput {
  guild: Guild;
  type: CaseType;
  user: User;
  mod: User;
  reason?: string | null;
  durationMs?: number | null;
  /** Skip DM (e.g. notes) */
  silent?: boolean;
}

export async function createCase(input: CaseInput) {
  const { guild, type, user, mod } = input;
  const number = await nextCaseNumber(guild.id);
  const expiresAt = input.durationMs ? new Date(Date.now() + input.durationMs) : null;
  const row = await db.case.create({
    data: { guildId: guild.id, number, type, userId: user.id, modId: mod.id, reason: input.reason ?? null, expiresAt },
  });

  const style = TYPE_STYLE[type];
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setAuthor({ name: `Case #${number} · ${style.label}`, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: "User", value: `${user} \`${user.id}\``, inline: true },
      { name: "Moderator", value: `${mod}`, inline: true },
    )
    .setDescription(input.reason ? `**Reason:** ${input.reason}` : "*No reason given*");
  if (input.durationMs) embed.addFields({ name: "Duration", value: formatDuration(input.durationMs), inline: true });
  await sendLog(guild, "mod", embed);
  return row;
}

/** DMs the user about an action. Must be called BEFORE kick/ban so the DM can still be delivered. */
export async function notifyUser(guild: Guild, user: User, type: CaseType, reason?: string | null, durationMs?: number | null) {
  if (type === "note") return false;
  const style = TYPE_STYLE[type];
  const cfg = await getConfig(guild.id);
  const embed = new EmbedBuilder()
    .setColor(style.color)
    .setTitle(`${style.emoji} You were ${style.verb} in ${guild.name}`)
    .setDescription(reason ? `**Reason:** ${reason}` : null);
  if (durationMs) embed.addFields({ name: "Duration", value: formatDuration(durationMs) });
  const components =
    (type === "ban" || type === "tempban") && cfg.appealChannelId
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`appeal:open:${guild.id}`).setLabel("Appeal this ban").setStyle(ButtonStyle.Secondary).setEmoji("📨"),
          ),
        ]
      : [];
  try {
    await user.send({ embeds: [embed], components });
    return true;
  } catch {
    return false;
  }
}

/** Counts active warns and applies the escalation ladder. Returns a description of what happened, if anything. */
export async function applyEscalation(guild: Guild, member: GuildMember): Promise<string | null> {
  const cfg = await getConfig(guild.id);
  if (!cfg.escalation.enabled || !cfg.escalation.steps.length) return null;
  const warns = await db.case.count({ where: { guildId: guild.id, userId: member.id, type: "warn", active: true } });
  const step = [...cfg.escalation.steps].sort((a, b) => b.warns - a.warns).find((s) => s.warns === warns);
  if (!step) return null;
  const me = guild.client.user;
  const reason = `Automatic: reached ${warns} warnings`;
  try {
    if (step.action === "timeout") {
      const ms = Math.min(step.durationMs ?? 3_600_000, MAX_TIMEOUT_MS);
      if (!member.moderatable) return null;
      await notifyUser(guild, member.user, "timeout", reason, ms);
      await member.timeout(ms, reason);
      await createCase({ guild, type: "timeout", user: member.user, mod: me, reason, durationMs: ms });
      return `timed out for ${formatDuration(ms)}`;
    }
    if (step.action === "kick") {
      if (!member.kickable) return null;
      await notifyUser(guild, member.user, "kick", reason);
      await member.kick(reason);
      await createCase({ guild, type: "kick", user: member.user, mod: me, reason });
      return "kicked";
    }
    if (step.action === "ban") {
      if (!member.bannable) return null;
      await notifyUser(guild, member.user, "ban", reason);
      await guild.members.ban(member.id, { reason });
      await createCase({ guild, type: "ban", user: member.user, mod: me, reason });
      return "banned";
    }
  } catch (err) {
    log.warn(`Escalation failed in ${guild.id}`, err);
  }
  return null;
}

/** Issues a warn (case + DM + escalation). Used by /warn and by the ad engine. */
export async function warnMember(guild: Guild, member: GuildMember, mod: User, reason: string) {
  const dmed = await notifyUser(guild, member.user, "warn", reason);
  const row = await createCase({ guild, type: "warn", user: member.user, mod, reason });
  const escalated = await applyEscalation(guild, member);
  return { case: row, dmed, escalated };
}

export async function isAdBanned(guildId: string, userId: string): Promise<boolean> {
  const c = await db.case.findFirst({
    where: {
      guildId,
      userId,
      type: "adban",
      active: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
  });
  return !!c;
}
