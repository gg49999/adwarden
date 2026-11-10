import { EmbedBuilder, type Message } from "discord.js";
import { db } from "../../db.js";
import { COLORS, codeBlock, truncate } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { isStaff } from "../../core/permissions.js";
import { log } from "../../logger.js";
import { botDelete, sendLog } from "../logging/logs.js";
import { createCase, notifyUser, warnMember } from "../moderation/service.js";
import { checkAd, type CheckResult } from "./checker.js";
import type { Violation } from "./engine.js";
import { sendToReview } from "./review.js";
import { summarizeRules, type ChannelRules } from "./rules.js";
import { adjustReputation, getAdRules, getReputation, markAdRemoved, recordAd } from "./store.js";

/** Runs ad checks on a new message. Returns true if the message was removed. */
export async function handleAdMessage(message: Message<true>): Promise<boolean> {
  const rules = getAdRules(message.channelId);
  if (!rules) return false;
  const cfg = await getConfig(message.guildId);
  if (!cfg.modules.ads) return false;
  if (cfg.ads.exemptStaff && isStaff(message.member)) return false;

  const result = await checkAd({
    guild: message.guild,
    channelId: message.channelId,
    authorId: message.author.id,
    member: message.member,
    content: message.content,
    rules,
    hasEveryoneMention: message.mentions.everyone,
    roleMentionCount: message.mentions.roles.size,
    attachmentCount: message.attachments.size + message.stickers.size,
  });

  if (result.violations.length) return applyViolations(message, rules, result, "posted");

  // Passed. Review-all channels still go to the queue unless the poster is trusted.
  if (rules.reviewAll && !(await isTrusted(message))) {
    const queued = await sendToReview({
      guild: message.guild,
      channelId: message.channelId,
      author: message.author,
      content: message.content,
      invite: result.primary,
      reason: "Channel reviews all ads",
    });
    if (queued) {
      await botDelete(message).catch(() => {});
      await message.author
        .send(`📥 Your ad in **${message.guild.name}** (<#${message.channelId}>) is waiting for staff review. You'll get a DM when it's handled.`)
        .catch(() => {});
      return true;
    }
  }

  await recordAd({
    messageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    inviteCode: result.primary?.code,
    targetGuildId: result.primary?.guildId,
    targetName: result.primary?.guildName,
    expiryDays: rules.expiryDays,
  });
  await adjustReputation(message.guildId, message.author.id, "clean");
  return false;
}

/** Re-checks a live ad after it was edited (catches bait-and-switch edits). */
export async function handleAdEdit(message: Message<true>) {
  const ad = await db.ad.findUnique({ where: { messageId: message.id } });
  if (!ad || ad.status !== "live" || ad.authorId !== message.author?.id) return;
  const rules = getAdRules(message.channelId);
  if (!rules) return;
  const cfg = await getConfig(message.guildId);
  if (!cfg.modules.ads || (cfg.ads.exemptStaff && isStaff(message.member))) return;

  const result = await checkAd({
    guild: message.guild,
    channelId: message.channelId,
    authorId: message.author.id,
    member: message.member,
    content: message.content,
    rules,
    hasEveryoneMention: message.mentions.everyone,
    roleMentionCount: message.mentions.roles.size,
    attachmentCount: message.attachments.size + message.stickers.size,
    excludeMessageId: message.id,
    skipCooldowns: true,
  });
  const switched = !!(ad.targetGuildId && result.primary?.guildId && result.primary.guildId !== ad.targetGuildId);
  if (switched) result.violations.push({ rule: "invalid_invite", message: "The invite was changed to a different server after posting." });
  if (result.violations.length) await applyViolations(message, rules, result, "edited");
}

async function isTrusted(message: Message<true>) {
  const cfg = await getConfig(message.guildId);
  if (cfg.ads.trustedRoleId && message.member?.roles.cache.has(cfg.ads.trustedRoleId)) return true;
  if (cfg.ads.trustedThreshold <= 0) return false;
  const rep = await getReputation(message.guildId, message.author.id);
  return rep.score >= cfg.ads.trustedThreshold;
}

async function applyViolations(message: Message<true>, rules: ChannelRules, result: CheckResult, how: "posted" | "edited"): Promise<boolean> {
  const { guild, author } = message;
  const cfg = await getConfig(guild.id);
  const v = result.violations;
  const first = v[0];

  await db.adViolation.createMany({
    data: v.map((x) => ({ guildId: guild.id, channelId: message.channelId, userId: author.id, rule: x.rule })),
  });
  await adjustReputation(guild.id, author.id, "violation");

  let removed = false;
  let outcome = "flagged";

  if (rules.action === "log") {
    outcome = "flagged (kept)";
  } else if (rules.action === "review" && first.rule !== "ad_banned") {
    const queued = await sendToReview({
      guild,
      channelId: message.channelId,
      author,
      content: message.content,
      invite: result.primary,
      reason: v.map((x) => x.rule).join(", "),
    });
    if (queued) {
      removed = await botDelete(message).then(() => true, () => false);
      outcome = "sent to review";
      await author.send(`📥 Your ad in **${guild.name}** needs a staff review before it goes up:\n${v.map((x) => `• ${x.message}`).join("\n")}`).catch(() => {});
    } else {
      removed = await botDelete(message).then(() => true, () => false);
      outcome = "removed (no review channel set)";
      if (cfg.ads.dmOnRemoval) await dmViolation(message, rules, v, how);
    }
  } else {
    removed = await botDelete(message).then(() => true, () => false);
    outcome = removed ? "removed" : "could not remove (missing Manage Messages?)";
    if (rules.action === "delete_dm" && cfg.ads.dmOnRemoval) await dmViolation(message, rules, v, how);
  }
  if (removed) await markAdRemoved(message.id, how === "edited" ? `edited: ${first.rule}` : first.rule);

  // Punishments
  const reason = `Ad rule: ${first.message}`;
  const member = message.member ?? (await guild.members.fetch(author.id).catch(() => null));
  if (member && rules.warnOnViolation && first.rule !== "user_cooldown" && first.rule !== "server_cooldown") {
    const w = await warnMember(guild, member, guild.client.user, reason).catch((e) => (log.warn("auto-warn failed", e), null));
    if (w) outcome += ` · warned (case #${w.case.number})${w.escalated ? ` · ${w.escalated}` : ""}`;
  }
  if (member && rules.timeoutMinutesOnViolation > 0 && member.moderatable) {
    const ms = rules.timeoutMinutesOnViolation * 60_000;
    await notifyUser(guild, author, "timeout", reason, ms);
    await member.timeout(ms, reason).catch(() => {});
    await createCase({ guild, type: "timeout", user: author, mod: guild.client.user, reason, durationMs: ms });
    outcome += " · timed out";
  }

  const embed = new EmbedBuilder()
    .setColor(how === "edited" ? COLORS.danger : COLORS.warn)
    .setAuthor({ name: `Ad ${outcome}${how === "edited" ? " after edit" : ""}`, iconURL: author.displayAvatarURL() })
    .setDescription(v.map((x) => `• **${x.rule}**: ${x.message}`).join("\n"))
    .addFields(
      { name: "Author", value: `${author} \`${author.id}\``, inline: true },
      { name: "Channel", value: `${message.channel}`, inline: true },
    );
  if (result.primary?.guildName) embed.addFields({ name: "Server", value: `${result.primary.guildName} \`${result.primary.guildId}\``, inline: true });
  embed.addFields({ name: "Content", value: codeBlock(message.content || "(empty)", 900) });
  await sendLog(guild, "ads", embed);
  return removed;
}

async function dmViolation(message: Message<true>, rules: ChannelRules, v: Violation[], how: "posted" | "edited") {
  const embed = new EmbedBuilder()
    .setColor(COLORS.warn)
    .setTitle(`Your ad in ${message.guild.name} was removed`)
    .setDescription(
      `${how === "edited" ? "It was changed after posting and no longer follows the rules.\n\n" : ""}**What to fix:**\n${v.map((x) => `• ${x.message}`).join("\n")}`,
    )
    .addFields(
      { name: "Channel rules", value: truncate(summarizeRules(rules) || "—", 1000) },
      { name: "Your ad (copy, fix, and repost)", value: codeBlock(message.content || "(empty)", 1000) },
    );
  await message.author.send({ embeds: [embed] }).catch(() => {});
}
