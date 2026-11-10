import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type GuildMember,
  type ModalSubmitInteraction,
  type ButtonInteraction,
} from "discord.js";
import { db } from "../../db.js";
import type { Command, ComponentHandler } from "../../core/command.js";
import { COLORS, codeBlock, truncate } from "../../core/embeds.js";
import { formatDuration, parseDuration } from "../../core/duration.js";
import { getConfig } from "../../core/guildConfig.js";
import { replyEmbed, replyErr, replyOk, respond } from "../../core/reply.js";
import { createCase } from "../moderation/service.js";
import { schedule } from "../sticky/service.js";
import { checkAd } from "./checker.js";
import { removeAdsForServer } from "./cleanup.js";
import { extractInviteCodes } from "./invites.js";
import { resolveInvite } from "./inviteResolver.js";
import { buildAdPost } from "./post.js";
import { sendToReview } from "./review.js";
import {
  PRESETS,
  presetRules,
  RULE_HELP,
  setRule,
  summarizeRules,
  type PresetName,
  type RuleKey,
} from "./rules.js";
import {
  adjustReputation,
  getAdRules,
  getReputation,
  listAdChannels,
  markAdRemoved,
  recordAd,
  removeAdChannel,
  setAdChannel,
  saveRulesForChannel,
  getAdChannel,
  getRuleset,
} from "./store.js";
import { ruleKeyAutocomplete } from "./rulesetCommands.js";

const AD_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const presetChoices = Object.keys(PRESETS).map((p) => ({ name: p, value: p }));

// ---------------------------------------------------------------- /ad

function adModal(channelId: string) {
  return new ModalBuilder()
    .setCustomId(`ad:submit:${channelId}`)
    .setTitle("Post an ad")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("invite").setLabel("Invite link").setPlaceholder("https://discord.gg/yourcode").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("description").setLabel("Describe your server").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1800),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("tags").setLabel("Tags (comma separated, optional)").setPlaceholder("gaming, community, 18+ free").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(150),
      ),
    );
}

async function openAdForm(i: ChatInputCommandInteraction | ButtonInteraction, channelId: string) {
  if (!getAdRules(channelId)) return replyErr(i, `<#${channelId}> isn't an ad channel.`);
  return i.showModal(adModal(channelId));
}

async function isTrustedMember(guildId: string, member: GuildMember | null) {
  if (!member) return false;
  const cfg = await getConfig(guildId);
  if (cfg.ads.trustedRoleId && member.roles.cache.has(cfg.ads.trustedRoleId)) return true;
  if (cfg.ads.trustedThreshold <= 0) return false;
  return (await getReputation(guildId, member.id)).score >= cfg.ads.trustedThreshold;
}

async function submitAdForm(i: ModalSubmitInteraction, channelId: string) {
  if (!i.inCachedGuild()) return;
  const rules = getAdRules(channelId);
  if (!rules) return replyErr(i, "That channel is no longer an ad channel.");
  await i.deferReply({ flags: 64 });
  const inviteRaw = i.fields.getTextInputValue("invite").trim();
  const description = i.fields.getTextInputValue("description").trim();
  const tags = i.fields.getTextInputValue("tags").trim();
  const code = extractInviteCodes(inviteRaw)[0] ?? (/^[a-z0-9-]{2,32}$/i.test(inviteRaw) ? inviteRaw : null);
  if (!code) return replyErr(i, "That doesn't look like a Discord invite. Use a link like `https://discord.gg/abc123`.");

  const content = `${description}\n${tags ? `Tags: ${tags}\n` : ""}https://discord.gg/${code}`;
  const result = await checkAd({
    guild: i.guild,
    channelId,
    authorId: i.user.id,
    member: i.member,
    content,
    rules,
    hasEveryoneMention: /@(everyone|here)\b/.test(description),
    roleMentionCount: (description.match(/<@&\d+>/g) ?? []).length,
  });
  if (result.violations.length) {
    return respond(i, {
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.warn)
          .setTitle("Your ad wasn't posted")
          .setDescription(result.violations.map((v) => `• ${v.message}`).join("\n"))
          .addFields({ name: "Channel rules", value: summarizeRules(rules) || "—" }),
      ],
    });
  }

  if (rules.reviewAll && !(await isTrustedMember(i.guildId, i.member))) {
    const ok = await sendToReview({ guild: i.guild, channelId, author: i.user, content: `${description}${tags ? `\nTags: ${tags}` : ""}`, invite: result.primary, reason: "Channel reviews all ads" });
    if (ok) return replyOk(i, "Your ad is in the review queue. You'll get a DM when staff handle it.");
  }

  const channel = await i.guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isSendable()) return replyErr(i, "I can't post in that channel. Ask staff to check my permissions.");
  const invite = result.primary ?? (await resolveInvite(code));
  const posted = await channel.send(buildAdPost(i.user, description, invite, tags));
  await recordAd({
    messageId: posted.id,
    channelId,
    guildId: i.guildId,
    authorId: i.user.id,
    inviteCode: invite.code,
    targetGuildId: invite.guildId,
    targetName: invite.guildName,
    expiryDays: rules.expiryDays,
  });
  await adjustReputation(i.guildId, i.user.id, "clean");
  schedule(channelId);
  return replyOk(i, `Posted! ${posted.url}`);
}

export const adComponents: ComponentHandler = {
  prefix: "ad",
  async handle(i, [action, channelId]) {
    if (action === "create" && i.isButton()) return openAdForm(i, channelId);
    if (action === "submit" && i.isModalSubmit()) return submitAdForm(i, channelId);
  },
};

const ad: Command = {
  module: "ads",
  summary: "Post, list and remove your ads; see ad stats",
  data: new SlashCommandBuilder()
    .setName("ad")
    .setDescription("Ads in this server")
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) =>
      s.setName("create").setDescription("Post a formatted ad with a form").addChannelOption((o) => o.setName("channel").setDescription("Ad channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true)),
    )
    .addSubcommand((s) => s.setName("mine").setDescription("List your live ads"))
    .addSubcommand((s) => s.setName("remove").setDescription("Remove one of your ads").addStringOption((o) => o.setName("message").setDescription("Message link or ID").setRequired(true)))
    .addSubcommand((s) => s.setName("rep").setDescription("Show advertiser reputation").addUserOption((o) => o.setName("user").setDescription("Defaults to you")))
    .addSubcommand((s) => s.setName("stats").setDescription("Ad statistics for the last 7 days")),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();

    if (sub === "create") return openAdForm(i, i.options.getChannel("channel", true).id);

    if (sub === "mine") {
      const ads = await db.ad.findMany({ where: { guildId: i.guildId, authorId: i.user.id, status: "live" }, orderBy: { createdAt: "desc" }, take: 15 });
      if (!ads.length) return replyErr(i, "You have no live ads here.");
      const lines = ads.map(
        (a) =>
          `• [${a.targetName ?? "Ad"}](https://discord.com/channels/${a.guildId}/${a.channelId}/${a.messageId}) in <#${a.channelId}> · posted <t:${Math.floor(a.createdAt.getTime() / 1000)}:R>${a.expiresAt ? ` · expires <t:${Math.floor(a.expiresAt.getTime() / 1000)}:R>` : ""}`,
      );
      return replyEmbed(i, new EmbedBuilder().setColor(COLORS.brand).setTitle("Your live ads").setDescription(lines.join("\n")));
    }

    if (sub === "remove") {
      const id = i.options.getString("message", true).split("/").pop()!.trim();
      const a = await db.ad.findUnique({ where: { messageId: id } });
      if (!a || a.guildId !== i.guildId || a.status !== "live") return replyErr(i, "I couldn't find a live ad with that ID.");
      const isMod = i.memberPermissions.has(PermissionFlagsBits.ManageMessages);
      if (a.authorId !== i.user.id && !isMod) return replyErr(i, "That isn't your ad.");
      const ch = await i.guild.channels.fetch(a.channelId).catch(() => null);
      if (ch?.isTextBased()) await ch.messages.delete(a.messageId).catch(() => {});
      await markAdRemoved(a.messageId, a.authorId === i.user.id ? "removed by author" : `removed by ${i.user.username}`);
      return replyOk(i, "Ad removed.");
    }

    if (sub === "rep") {
      const user = i.options.getUser("user") ?? i.user;
      const rep = await getReputation(i.guildId, user.id);
      const cfg = await getConfig(i.guildId);
      const trusted = cfg.ads.trustedThreshold > 0 && rep.score >= cfg.ads.trustedThreshold;
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(trusted ? COLORS.ok : COLORS.brand)
          .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
          .setTitle(`Reputation: ${rep.score}${trusted ? " · ⭐ Trusted" : ""}`)
          .setDescription(`Clean ads: **${rep.clean}** · Violations: **${rep.violations}**${cfg.ads.trustedThreshold ? `\nTrusted at ${cfg.ads.trustedThreshold}+ (skips review)` : ""}`),
      );
    }

    if (sub === "stats") {
      const since = new Date(Date.now() - 7 * 86_400_000);
      const [total, topServers, topAuthors, byRule, removed] = await Promise.all([
        db.ad.count({ where: { guildId: i.guildId, createdAt: { gte: since } } }),
        db.ad.groupBy({ by: ["targetGuildId", "targetName"], where: { guildId: i.guildId, createdAt: { gte: since }, targetGuildId: { not: null } }, _count: true, orderBy: { _count: { targetGuildId: "desc" } }, take: 5 }),
        db.ad.groupBy({ by: ["authorId"], where: { guildId: i.guildId, createdAt: { gte: since } }, _count: true, orderBy: { _count: { authorId: "desc" } }, take: 5 }),
        db.adViolation.groupBy({ by: ["rule"], where: { guildId: i.guildId, createdAt: { gte: since } }, _count: true, orderBy: { _count: { rule: "desc" } }, take: 8 }),
        db.ad.groupBy({ by: ["removedReason"], where: { guildId: i.guildId, status: { in: ["removed", "expired"] }, createdAt: { gte: since } }, _count: true }),
      ]);
      const violations = byRule.reduce((n, r) => n + r._count, 0);
      const fmt = (rows: string[]) => rows.join("\n") || "—";
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle("📊 Ad stats · last 7 days")
          .setDescription(`**${total}** ads posted · **${violations}** rule violations${total + violations ? ` · ${Math.round((violations / (total + violations)) * 100)}% rejection rate` : ""}`)
          .addFields(
            { name: "Most advertised servers", value: fmt(topServers.map((s, n) => `${n + 1}. ${s.targetName ?? s.targetGuildId} · ${s._count}`)), inline: true },
            { name: "Top advertisers", value: fmt(topAuthors.map((a, n) => `${n + 1}. <@${a.authorId}> · ${a._count}`)), inline: true },
            { name: "Rules triggered most", value: fmt(byRule.map((r) => `\`${r.rule}\` · ${r._count}`)) },
            { name: "Cleaned up", value: fmt(removed.map((r) => `${r.removedReason ?? "removed"} · ${r._count}`)) },
          ),
        true,
      );
    }
  },
};

// ---------------------------------------------------------------- /adchannel

const adchannel: Command = {
  module: "ads",
  summary: "Turn channels into ad channels and tune their rules",
  data: new SlashCommandBuilder()
    .setName("adchannel")
    .setDescription("Configure ad channels")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Make a channel an ad channel using a preset")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true))
        .addStringOption((o) => o.setName("preset").setDescription("Starting rules").addChoices(...presetChoices).setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("rule")
        .setDescription("Change one rule")
        .addChannelOption((o) => o.setName("channel").setDescription("Ad channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true))
        .addStringOption((o) => o.setName("rule").setDescription("Rule").setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName("value").setDescription("New value (on/off, a number, or a comma list)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("view").setDescription("Show a channel's rules").addChannelOption((o) => o.setName("channel").setDescription("Ad channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true)),
    )
    .addSubcommand((s) => s.setName("list").setDescription("List ad channels"))
    .addSubcommand((s) =>
      s.setName("remove").setDescription("Stop checking a channel").addChannelOption((o) => o.setName("channel").setDescription("Ad channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true)),
    ),
  async autocomplete(i) {
    return i.respond(ruleKeyAutocomplete(String(i.options.getFocused())));
  },
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    const channel = i.options.getChannel("channel");

    if (sub === "set") {
      const preset = i.options.getString("preset", true) as PresetName;
      await setAdChannel(i.guildId, channel!.id, presetRules(preset));
      return replyOk(i, `${channel} is now an ad channel using the **${preset}** preset.\n${summarizeRules(presetRules(preset))}\n\nTip: \`/sticky set\` adds a "Post an Ad" button that stays at the bottom.`);
    }
    if (sub === "list") {
      const list = listAdChannels(i.guildId);
      if (!list.length) return replyErr(i, "No ad channels yet. Use `/adchannel set` or `/setup`.");
      return replyEmbed(i, new EmbedBuilder().setColor(COLORS.brand).setTitle("Ad channels").setDescription(list.map((c) => `<#${c.channelId}>${c.ruleset ? ` · 📚 ${c.ruleset.name}` : ""} · ${summarizeRules(c.rules)}`).join("\n")));
    }

    const rules = getAdRules(channel!.id);
    if (!rules) return replyErr(i, `${channel} isn't an ad channel. Use \`/adchannel set\` first.`);

    if (sub === "remove") {
      await removeAdChannel(channel!.id);
      return replyOk(i, `${channel} is no longer checked.`);
    }
    if (sub === "rule") {
      const key = i.options.getString("rule", true) as RuleKey;
      if (!(key in RULE_HELP)) return replyErr(i, "Unknown rule. Pick one from the list.");
      const next = setRule(rules, key, i.options.getString("value", true));
      if (typeof next === "string") return replyErr(i, next);
      await saveRulesForChannel(i.guildId, channel!.id, next);
      const rsId = getAdChannel(channel!.id)?.rulesetId;
      const rs = rsId ? getRuleset(rsId) : undefined;
      return replyOk(i, `\`${key}\` is now **${JSON.stringify(next[key])}** ${rs ? `in ruleset **${rs.name}** (all channels using it)` : `in ${channel}`}.`);
    }
    if (sub === "view") {
      const lines = (Object.keys(RULE_HELP) as RuleKey[]).map((k) => `\`${k}\` **${JSON.stringify(rules[k])}** · ${RULE_HELP[k]}`);
      const rsId = getAdChannel(channel!.id)?.rulesetId;
      const rs = rsId ? getRuleset(rsId) : undefined;
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`Rules for #${channel!.name}`)
          .setDescription(truncate((rs ? `Follows ruleset **${rs.name}**\n\n` : "") + lines.join("\n"), 4000)),
      );
    }
  },
};

// ---------------------------------------------------------------- /blocklist

const blocklist: Command = {
  module: "ads",
  summary: "Block servers from being advertised (by server ID, so new invites are caught too)",
  data: new SlashCommandBuilder()
    .setName("blocklist")
    .setDescription("Servers that may not be advertised")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Block a server")
        .addStringOption((o) => o.setName("server").setDescription("An invite link or a server ID").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((s) => s.setName("remove").setDescription("Unblock a server").addStringOption((o) => o.setName("server_id").setDescription("Server ID").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List blocked servers")),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    if (sub === "add") {
      await i.deferReply({ flags: 64 });
      const raw = i.options.getString("server", true).trim();
      let targetGuildId = /^\d{15,22}$/.test(raw) ? raw : undefined;
      let targetName: string | undefined;
      if (!targetGuildId) {
        const code = extractInviteCodes(raw)[0] ?? raw;
        const inv = await resolveInvite(code, { fresh: true });
        if (!inv.valid || !inv.guildId) return replyErr(i, "That invite is invalid. Use the server ID instead (right-click the server icon → Copy Server ID).");
        targetGuildId = inv.guildId;
        targetName = inv.guildName;
      }
      await db.blockedServer.upsert({
        where: { guildId_targetGuildId: { guildId: i.guildId, targetGuildId } },
        create: { guildId: i.guildId, targetGuildId, targetName, reason: i.options.getString("reason"), addedBy: i.user.id },
        update: { reason: i.options.getString("reason"), targetName },
      });
      const removed = await removeAdsForServer(i.guild, targetGuildId);
      return replyOk(i, `Blocked **${targetName ?? targetGuildId}**.${removed ? ` Removed ${removed} existing ad(s) for it.` : ""}`);
    }
    if (sub === "remove") {
      const id = i.options.getString("server_id", true).trim();
      const r = await db.blockedServer.deleteMany({ where: { guildId: i.guildId, targetGuildId: id } });
      return r.count ? replyOk(i, "Server unblocked.") : replyErr(i, "That server isn't blocked.");
    }
    const rows = await db.blockedServer.findMany({ where: { guildId: i.guildId }, orderBy: { createdAt: "desc" }, take: 40 });
    if (!rows.length) return replyErr(i, "No blocked servers.");
    return replyEmbed(
      i,
      new EmbedBuilder().setColor(COLORS.danger).setTitle(`Blocked servers (${rows.length})`).setDescription(rows.map((r) => `• **${r.targetName ?? "Unknown"}** \`${r.targetGuildId}\`${r.reason ? ` · ${truncate(r.reason, 80)}` : ""}`).join("\n")),
    );
  },
};

// ---------------------------------------------------------------- /test-ad

const testAd: Command = {
  module: "ads",
  summary: "Dry-run an ad against a channel's rules without posting it",
  data: new SlashCommandBuilder()
    .setName("test-ad")
    .setDescription("Check an ad against a channel's rules without posting it")
    .setContexts(InteractionContextType.Guild)
    .addChannelOption((o) => o.setName("channel").setDescription("Ad channel").addChannelTypes(...AD_CHANNEL_TYPES).setRequired(true))
    .addStringOption((o) => o.setName("content").setDescription("The ad text (use \\n for new lines)").setRequired(true).setMaxLength(4000)),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const channel = i.options.getChannel("channel", true);
    const rules = getAdRules(channel.id);
    if (!rules) return replyErr(i, `${channel} isn't an ad channel.`);
    await i.deferReply({ flags: 64 });
    const content = i.options.getString("content", true).replace(/\\n/g, "\n");
    const r = await checkAd({
      guild: i.guild,
      channelId: channel.id,
      authorId: i.user.id,
      member: i.member,
      content,
      rules,
      hasEveryoneMention: /@(everyone|here)\b/.test(content),
      roleMentionCount: (content.match(/<@&\d+>/g) ?? []).length,
    });
    const inv = r.primary;
    const embed = new EmbedBuilder()
      .setColor(r.violations.length ? COLORS.warn : COLORS.ok)
      .setTitle(r.violations.length ? `Would be rejected (${r.violations.length})` : "✅ Would pass")
      .setDescription(r.violations.map((v) => `• \`${v.rule}\` ${v.message}`).join("\n") || "No rules triggered.")
      .addFields({ name: "Content", value: codeBlock(content, 800) });
    if (inv)
      embed.addFields({
        name: "Invite",
        value: inv.valid ? `**${inv.guildName ?? "?"}** · ${inv.memberCount ?? "?"} members · NSFW level ${inv.nsfwLevel ?? "?"}` : `\`${inv.code}\` is invalid`,
      });
    return respond(i, { embeds: [embed] });
  },
};

// ---------------------------------------------------------------- /adban

const adban: Command = {
  module: "ads",
  summary: "Stop someone from posting ads without banning them",
  data: new SlashCommandBuilder()
    .setName("adban")
    .setDescription("Ban or unban a user from posting ads")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName("add")
        .setDescription("Ban a user from advertising")
        .addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))
        .addStringOption((o) => o.setName("duration").setDescription("e.g. 7d, 12h. Empty = permanent"))
        .addStringOption((o) => o.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((s) => s.setName("remove").setDescription("Lift an ad ban").addUserOption((o) => o.setName("user").setDescription("User").setRequired(true))),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const user = i.options.getUser("user", true);
    if (i.options.getSubcommand() === "add") {
      const raw = i.options.getString("duration");
      const ms = raw ? parseDuration(raw) : null;
      if (raw && !ms) return replyErr(i, "Invalid duration. Try `7d`, `12h` or `30m`.");
      const reason = i.options.getString("reason");
      const c = await createCase({ guild: i.guild, type: "adban", user, mod: i.user, reason, durationMs: ms });
      await user.send(`🚫 You can't post ads in **${i.guild.name}**${ms ? ` for ${formatDuration(ms)}` : ""}.${reason ? `\nReason: ${reason}` : ""}`).catch(() => {});
      return replyOk(i, `${user} is banned from advertising${ms ? ` for ${formatDuration(ms)}` : ""}. Case #${c.number}`);
    }
    const r = await db.case.updateMany({ where: { guildId: i.guildId, userId: user.id, type: "adban", active: true }, data: { active: false } });
    if (!r.count) return replyErr(i, `${user} isn't ad banned.`);
    await createCase({ guild: i.guild, type: "adunban", user, mod: i.user });
    return replyOk(i, `${user} can advertise again.`);
  },
};

export const adCommands = [ad, adchannel, blocklist, testAd, adban];
