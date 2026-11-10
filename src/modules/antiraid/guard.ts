import { EmbedBuilder, type GuildMember, type Message } from "discord.js";
import { COLORS, codeBlock } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { isStaff } from "../../core/permissions.js";
import { log } from "../../logger.js";
import { fingerprint, extractLinks } from "../ads/invites.js";
import { botDelete, sendLog } from "../logging/logs.js";
import { createCase, notifyUser } from "../moderation/service.js";
import { startLockdown } from "../moderation/lockdown.js";
import { isScamHost, looksLikeScam } from "./scamLinks.js";

// ---- Message guard ------------------------------------------------------------

/** Recent message fingerprints per user, for cross-channel spam. */
const recent = new Map<string, { fp: string; channelId: string; at: number; messageId: string }[]>();

/** Returns true if the message was removed. Runs before the ad engine. */
export async function guardMessage(message: Message<true>): Promise<boolean> {
  const cfg = await getConfig(message.guildId);
  if (!cfg.modules.antiraid || isStaff(message.member)) return false;
  const ar = cfg.antiraid;

  // 1. Scam links
  if (ar.scamLinks) {
    const bad = extractLinks(message.content).find((l) => isScamHost(l.host) || looksLikeScam(l.host));
    if (bad) {
      await punish(message, `Scam/phishing link (${bad.host})`, ar.scamAction);
      return true;
    }
  }

  // 2. Mention spam
  if (ar.maxMentions > 0) {
    const n = message.mentions.users.size + message.mentions.roles.size;
    if (n > ar.maxMentions) {
      await punish(message, `Mass mention (${n} mentions)`, "delete_timeout", 10 * 60_000);
      return true;
    }
  }

  // 3. Same message in several channels within 30s
  if (ar.crossChannelSpam && message.content.length >= 10) {
    const key = `${message.guildId}:${message.author.id}`;
    const fp = fingerprint(message.content);
    const now = Date.now();
    const list = (recent.get(key) ?? []).filter((e) => now - e.at < 30_000);
    list.push({ fp, channelId: message.channelId, at: now, messageId: message.id });
    recent.set(key, list);
    const same = list.filter((e) => e.fp === fp);
    if (new Set(same.map((e) => e.channelId)).size >= 3) {
      for (const e of same) {
        const ch = message.guild.channels.cache.get(e.channelId);
        if (ch?.isTextBased()) await ch.messages.delete(e.messageId).catch(() => {});
      }
      recent.delete(key);
      await punish(message, "Posting the same message in several channels", "delete_timeout", 30 * 60_000);
      return true;
    }
  }
  return false;
}

async function punish(message: Message<true>, reason: string, action: "delete" | "delete_timeout" | "delete_ban", timeoutMs = 86_400_000) {
  const { guild, author } = message;
  await botDelete(message).catch(() => {});
  const member = message.member;
  let did = "deleted";
  try {
    if (action === "delete_timeout" && member?.moderatable) {
      await notifyUser(guild, author, "timeout", `Automatic: ${reason}`, timeoutMs);
      await member.timeout(timeoutMs, reason);
      await createCase({ guild, type: "timeout", user: author, mod: guild.client.user, reason: `Automatic: ${reason}`, durationMs: timeoutMs });
      did = "deleted + timed out";
    } else if (action === "delete_ban" && member?.bannable) {
      await notifyUser(guild, author, "ban", `Automatic: ${reason}`);
      await guild.members.ban(author.id, { reason, deleteMessageSeconds: 3600 });
      await createCase({ guild, type: "ban", user: author, mod: guild.client.user, reason: `Automatic: ${reason}` });
      did = "deleted + banned";
    }
  } catch (err) {
    log.warn("Anti-spam punishment failed", err);
  }
  await sendLog(
    guild,
    "mod",
    new EmbedBuilder()
      .setColor(COLORS.danger)
      .setAuthor({ name: `Anti-spam: ${did}`, iconURL: author.displayAvatarURL() })
      .setDescription(`${author} in ${message.channel}\n**${reason}**`)
      .addFields({ name: "Content", value: codeBlock(message.content || "(empty)", 800) }),
  );
}

// ---- Join guard ----------------------------------------------------------------

const joins = new Map<string, number[]>();
const alerted = new Map<string, number>();

export async function guardJoin(member: GuildMember) {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.modules.antiraid) return;
  const ar = cfg.antiraid;
  const guild = member.guild;

  // Join burst detection
  if (ar.joinBurstCount > 0) {
    const now = Date.now();
    const list = (joins.get(guild.id) ?? []).filter((t) => now - t < ar.joinBurstSeconds * 1000);
    list.push(now);
    joins.set(guild.id, list);
    if (list.length >= ar.joinBurstCount && now - (alerted.get(guild.id) ?? 0) > 5 * 60_000) {
      alerted.set(guild.id, now);
      let extra = "";
      if (ar.autoLockdown) {
        const n = await startLockdown(guild, `Automatic: ${list.length} joins in ${ar.joinBurstSeconds}s`);
        extra = n === null ? "" : `\nAuto-lockdown locked ${n} channel(s). End it with \`/lockdown end\`.`;
      }
      await sendLog(
        guild,
        "mod",
        new EmbedBuilder().setColor(COLORS.danger).setTitle("🚨 Possible raid").setDescription(`${list.length} members joined in ${ar.joinBurstSeconds}s.${extra || "\nRun `/lockdown start` if this is a raid."}`),
      );
    }
  }

  // Account age gate
  if (ar.minAccountAgeDays > 0) {
    const ageDays = (Date.now() - member.user.createdTimestamp) / 86_400_000;
    if (ageDays < ar.minAccountAgeDays) {
      let did = "logged";
      try {
        if (ar.youngAccountAction === "quarantine" && ar.quarantineRoleId) {
          await member.roles.add(ar.quarantineRoleId, "Account too new");
          did = "quarantined";
        } else if (ar.youngAccountAction === "kick" && member.kickable) {
          await member.send(`Your account is too new to join **${guild.name}**. Accounts must be at least ${ar.minAccountAgeDays} day(s) old.`).catch(() => {});
          await member.kick("Account too new");
          did = "kicked";
        }
      } catch (err) {
        log.warn("Account age action failed", err);
      }
      await sendLog(
        guild,
        "members",
        new EmbedBuilder()
          .setColor(COLORS.warn)
          .setDescription(`🆕 ${member} \`${member.id}\` joined with an account ${ageDays.toFixed(1)} day(s) old · **${did}**`),
      );
    }
  }
}
