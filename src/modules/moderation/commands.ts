import {
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
} from "discord.js";
import { db } from "../../db.js";
import type { Command } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { formatDuration, MAX_TIMEOUT_MS, parseDuration } from "../../core/duration.js";
import { assertBotPerms, assertCanModerate } from "../../core/permissions.js";
import { replyEmbed, replyErr, replyOk, UserError } from "../../core/reply.js";
import { extractInviteCodes, extractLinks } from "../ads/invites.js";
import { caseLabel, createCase, notifyUser, warnMember } from "./service.js";
import { endLockdown, startLockdown } from "./lockdown.js";

const userOpt = (desc = "User") => (o: import("discord.js").SlashCommandUserOption) => o.setName("user").setDescription(desc).setRequired(true);
const reasonOpt = (o: import("discord.js").SlashCommandStringOption) => o.setName("reason").setDescription("Reason").setMaxLength(500);

async function targetMember(i: ChatInputCommandInteraction<"cached">): Promise<GuildMember> {
  const user = i.options.getUser("user", true);
  const member = await i.guild.members.fetch(user.id).catch(() => null);
  if (!member) throw new UserError(`${user} isn't in this server.`);
  assertCanModerate(i.guild, i.member, member);
  return member;
}

const dmNote = (dmed: boolean) => (dmed ? "" : " (couldn't DM them)");

const warn: Command = {
  module: "moderation",
  summary: "Warn a member (counts toward the escalation ladder)",
  data: new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a member")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt())
    .addStringOption((o) => reasonOpt(o).setRequired(true)),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const member = await targetMember(i);
    const r = await warnMember(i.guild, member, i.user, i.options.getString("reason", true));
    const warns = await db.case.count({ where: { guildId: i.guildId, userId: member.id, type: "warn", active: true } });
    return replyOk(i, `Warned ${member} · case #${r.case.number} · ${warns} active warning(s)${r.escalated ? ` · automatically ${r.escalated}` : ""}${dmNote(r.dmed)}`);
  },
};

const timeout: Command = {
  module: "moderation",
  summary: "Time out a member",
  data: new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Time out a member")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt())
    .addStringOption((o) => o.setName("duration").setDescription("e.g. 10m, 2h, 7d (max 28d)").setRequired(true))
    .addStringOption(reasonOpt),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const member = await targetMember(i);
    const ms = parseDuration(i.options.getString("duration", true));
    if (!ms) return replyErr(i, "Invalid duration. Try `10m`, `2h` or `7d`.");
    if (ms > MAX_TIMEOUT_MS) return replyErr(i, "Discord timeouts can be at most 28 days.");
    const reason = i.options.getString("reason");
    const dmed = await notifyUser(i.guild, member.user, "timeout", reason, ms);
    await member.timeout(ms, reason ?? undefined);
    const c = await createCase({ guild: i.guild, type: "timeout", user: member.user, mod: i.user, reason, durationMs: ms });
    return replyOk(i, `Timed out ${member} for ${formatDuration(ms)} · case #${c.number}${dmNote(dmed)}`);
  },
};

const untimeout: Command = {
  module: "moderation",
  summary: "Remove a timeout",
  data: new SlashCommandBuilder()
    .setName("untimeout")
    .setDescription("Remove a member's timeout")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt())
    .addStringOption(reasonOpt),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const member = await targetMember(i);
    if (!member.isCommunicationDisabled()) return replyErr(i, `${member} isn't timed out.`);
    const reason = i.options.getString("reason");
    await member.timeout(null, reason ?? undefined);
    const c = await createCase({ guild: i.guild, type: "untimeout", user: member.user, mod: i.user, reason });
    return replyOk(i, `Removed ${member}'s timeout · case #${c.number}`);
  },
};

const kick: Command = {
  module: "moderation",
  summary: "Kick a member",
  data: new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a member")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .addUserOption(userOpt())
    .addStringOption(reasonOpt),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const member = await targetMember(i);
    const reason = i.options.getString("reason");
    const dmed = await notifyUser(i.guild, member.user, "kick", reason);
    await member.kick(reason ?? undefined);
    const c = await createCase({ guild: i.guild, type: "kick", user: member.user, mod: i.user, reason });
    return replyOk(i, `Kicked ${member.user.username} · case #${c.number}${dmNote(dmed)}`);
  },
};

const ban: Command = {
  module: "moderation",
  summary: "Ban a user (optionally temporary)",
  data: new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a user, optionally for a limited time")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(userOpt())
    .addStringOption(reasonOpt)
    .addStringOption((o) => o.setName("duration").setDescription("Temporary ban, e.g. 7d. Empty = permanent"))
    .addIntegerOption((o) => o.setName("delete_messages").setDescription("Delete their recent messages").addChoices(
      { name: "Don't delete", value: 0 }, { name: "Last hour", value: 3600 }, { name: "Last 24 hours", value: 86400 }, { name: "Last 7 days", value: 604800 },
    )),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const user = i.options.getUser("user", true);
    const member = await i.guild.members.fetch(user.id).catch(() => null);
    if (member) assertCanModerate(i.guild, i.member, member);
    const raw = i.options.getString("duration");
    const ms = raw ? parseDuration(raw) : null;
    if (raw && !ms) return replyErr(i, "Invalid duration. Try `7d` or `12h`.");
    const reason = i.options.getString("reason");
    const type = ms ? "tempban" : "ban";
    const dmed = member ? await notifyUser(i.guild, user, type, reason, ms) : false;
    await i.guild.members.ban(user.id, { reason: reason ?? undefined, deleteMessageSeconds: i.options.getInteger("delete_messages") ?? 0 });
    const c = await createCase({ guild: i.guild, type, user, mod: i.user, reason, durationMs: ms });
    return replyOk(i, `Banned ${user.username}${ms ? ` for ${formatDuration(ms)}` : ""} · case #${c.number}${member ? dmNote(dmed) : ""}`);
  },
};

const softban: Command = {
  module: "moderation",
  summary: "Ban and immediately unban to wipe recent messages",
  data: new SlashCommandBuilder()
    .setName("softban")
    .setDescription("Kick a member and delete their last 24h of messages")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(userOpt())
    .addStringOption(reasonOpt),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const member = await targetMember(i);
    const reason = i.options.getString("reason");
    const dmed = await notifyUser(i.guild, member.user, "softban", reason);
    await i.guild.members.ban(member.id, { reason: `Softban: ${reason ?? "no reason"}`, deleteMessageSeconds: 86400 });
    await i.guild.members.unban(member.id, "Softban release");
    const c = await createCase({ guild: i.guild, type: "softban", user: member.user, mod: i.user, reason });
    return replyOk(i, `Softbanned ${member.user.username} · case #${c.number}${dmNote(dmed)}`);
  },
};

const unban: Command = {
  module: "moderation",
  summary: "Unban a user by ID",
  data: new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a user")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addStringOption((o) => o.setName("user_id").setDescription("User ID").setRequired(true))
    .addStringOption(reasonOpt),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const id = i.options.getString("user_id", true).replace(/\D/g, "");
    const ban = await i.guild.bans.fetch(id).catch(() => null);
    if (!ban) return replyErr(i, "That user isn't banned.");
    const reason = i.options.getString("reason");
    await i.guild.members.unban(id, reason ?? undefined);
    await db.case.updateMany({ where: { guildId: i.guildId, userId: id, type: "tempban", active: true }, data: { active: false } });
    const c = await createCase({ guild: i.guild, type: "unban", user: ban.user, mod: i.user, reason });
    return replyOk(i, `Unbanned ${ban.user.username} · case #${c.number}`);
  },
};

const note: Command = {
  module: "moderation",
  summary: "Add a private mod note to a user",
  data: new SlashCommandBuilder()
    .setName("note")
    .setDescription("Add a private moderator note to a user")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt())
    .addStringOption((o) => o.setName("text").setDescription("Note").setRequired(true).setMaxLength(1000)),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const user = i.options.getUser("user", true);
    const c = await createCase({ guild: i.guild, type: "note", user, mod: i.user, reason: i.options.getString("text", true), silent: true });
    return replyOk(i, `Note added to ${user} · case #${c.number}`);
  },
};

const history: Command = {
  module: "moderation",
  summary: "A user's full moderation record",
  data: new SlashCommandBuilder()
    .setName("history")
    .setDescription("Show a user's moderation history")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addUserOption(userOpt()),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const user = i.options.getUser("user", true);
    const cases = await db.case.findMany({ where: { guildId: i.guildId, userId: user.id }, orderBy: { number: "desc" }, take: 25 });
    const activeWarns = cases.filter((c) => c.type === "warn" && c.active).length;
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setAuthor({ name: `${user.username} · ${cases.length} case(s)`, iconURL: user.displayAvatarURL() })
      .setDescription(
        cases.length
          ? cases
              .map((c) => `\`#${c.number}\` **${caseLabel(c.type)}**${c.active ? "" : " ~~voided~~"} <t:${Math.floor(c.createdAt.getTime() / 1000)}:d> by <@${c.modId}>${c.reason ? ` · ${truncate(c.reason, 90)}` : ""}`)
              .join("\n")
          : "Clean record.",
      )
      .setFooter({ text: `Active warnings: ${activeWarns}` });
    return replyEmbed(i, embed);
  },
};

const caseCmd: Command = {
  module: "moderation",
  summary: "View, re-reason or void a case",
  data: new SlashCommandBuilder()
    .setName("case")
    .setDescription("Manage moderation cases")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand((s) => s.setName("view").setDescription("View a case").addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true)))
    .addSubcommand((s) =>
      s
        .setName("reason")
        .setDescription("Change a case's reason")
        .addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true))
        .addStringOption((o) => o.setName("reason").setDescription("New reason").setRequired(true).setMaxLength(500)),
    )
    .addSubcommand((s) => s.setName("void").setDescription("Void a case (a voided warn no longer counts)").addIntegerOption((o) => o.setName("number").setDescription("Case number").setRequired(true))),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const number = i.options.getInteger("number", true);
    const c = await db.case.findUnique({ where: { guildId_number: { guildId: i.guildId, number } } });
    if (!c) return replyErr(i, `Case #${number} doesn't exist.`);
    const sub = i.options.getSubcommand();
    if (sub === "reason") {
      await db.case.update({ where: { id: c.id }, data: { reason: i.options.getString("reason", true) } });
      return replyOk(i, `Updated the reason for case #${number}.`);
    }
    if (sub === "void") {
      await db.case.update({ where: { id: c.id }, data: { active: false } });
      return replyOk(i, `Case #${number} voided.`);
    }
    return replyEmbed(
      i,
      new EmbedBuilder()
        .setColor(c.active ? COLORS.brand : COLORS.muted)
        .setTitle(`Case #${c.number} · ${caseLabel(c.type)}${c.active ? "" : " (voided)"}`)
        .addFields(
          { name: "User", value: `<@${c.userId}> \`${c.userId}\``, inline: true },
          { name: "Moderator", value: `<@${c.modId}>`, inline: true },
          { name: "Date", value: `<t:${Math.floor(c.createdAt.getTime() / 1000)}:f>`, inline: true },
          { name: "Reason", value: c.reason ?? "*None*" },
        )
        .setFooter(c.expiresAt ? { text: `Expires ${c.expiresAt.toUTCString()}` } : null),
    );
  },
};

const purge: Command = {
  module: "moderation",
  summary: "Bulk-delete messages with filters",
  data: new SlashCommandBuilder()
    .setName("purge")
    .setDescription("Bulk-delete recent messages (under 14 days old)")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addIntegerOption((o) => o.setName("amount").setDescription("How many messages to scan (1-100)").setMinValue(1).setMaxValue(100).setRequired(true))
    .addUserOption((o) => o.setName("user").setDescription("Only this user's messages"))
    .addStringOption((o) =>
      o.setName("filter").setDescription("Only messages that…").addChoices(
        { name: "are from bots", value: "bots" },
        { name: "contain links", value: "links" },
        { name: "contain invites", value: "invites" },
        { name: "have attachments", value: "attachments" },
        { name: "are from humans", value: "humans" },
      ),
    )
    .addStringOption((o) => o.setName("contains").setDescription("Only messages containing this text")),
  async execute(i) {
    if (!i.inCachedGuild() || !i.channel) return;
    const channel = i.channel as GuildTextBasedChannel;
    assertBotPerms(channel, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ReadMessageHistory);
    await i.deferReply({ flags: 64 });
    const amount = i.options.getInteger("amount", true);
    const user = i.options.getUser("user");
    const filter = i.options.getString("filter");
    const contains = i.options.getString("contains")?.toLowerCase();
    const fetched = await channel.messages.fetch({ limit: amount });
    const test = (m: Message) => {
      if (user && m.author.id !== user.id) return false;
      if (filter === "bots" && !m.author.bot) return false;
      if (filter === "humans" && m.author.bot) return false;
      if (filter === "links" && !extractLinks(m.content).length) return false;
      if (filter === "invites" && !extractInviteCodes(m.content).length) return false;
      if (filter === "attachments" && !m.attachments.size) return false;
      if (contains && !m.content.toLowerCase().includes(contains)) return false;
      return true;
    };
    const targets = fetched.filter(test);
    if (!targets.size) return replyErr(i, "No messages matched.");
    if (!("bulkDelete" in channel)) return replyErr(i, "This channel type doesn't support bulk delete.");
    const deleted = await channel.bulkDelete(targets, true);
    const skipped = targets.size - deleted.size;
    return replyOk(i, `Deleted ${deleted.size} message(s).${skipped ? ` Skipped ${skipped} older than 14 days.` : ""}`);
  },
};

const lock: Command = {
  module: "moderation",
  summary: "Lock or unlock a channel; set slowmode",
  data: new SlashCommandBuilder()
    .setName("channel")
    .setDescription("Lock, unlock, or set slowmode on a channel")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addSubcommand((s) =>
      s.setName("lock").setDescription("Stop @everyone from sending messages")
        .addChannelOption((o) => o.setName("channel").setDescription("Defaults to this channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(reasonOpt),
    )
    .addSubcommand((s) =>
      s.setName("unlock").setDescription("Let @everyone send messages again")
        .addChannelOption((o) => o.setName("channel").setDescription("Defaults to this channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    )
    .addSubcommand((s) =>
      s.setName("slowmode").setDescription("Set slowmode")
        .addStringOption((o) => o.setName("delay").setDescription("e.g. 5s, 1m, 2h; 0 to turn off").setRequired(true))
        .addChannelOption((o) => o.setName("channel").setDescription("Defaults to this channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)),
    ),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const ch = (i.options.getChannel("channel") ?? i.channel) as GuildTextBasedChannel | null;
    if (!ch || !("permissionOverwrites" in ch)) return replyErr(i, "Pick a text channel.");
    const sub = i.options.getSubcommand();
    if (sub === "slowmode") {
      const raw = i.options.getString("delay", true);
      const ms = raw.trim() === "0" ? 0 : parseDuration(raw);
      if (ms === null || ms > 21_600_000) return replyErr(i, "Use a delay between 0 and 6h.");
      if (!("setRateLimitPerUser" in ch)) return replyErr(i, "This channel doesn't support slowmode.");
      await ch.setRateLimitPerUser(Math.round(ms / 1000));
      return replyOk(i, ms ? `Slowmode in ${ch} set to ${formatDuration(ms)}.` : `Slowmode off in ${ch}.`);
    }
    const locking = sub === "lock";
    await ch.permissionOverwrites.edit(i.guild.roles.everyone, { SendMessages: locking ? false : null }, { reason: `${locking ? "Locked" : "Unlocked"} by ${i.user.username}` });
    if (locking) await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.warn).setDescription(`🔒 This channel is locked.${i.options.getString("reason") ? ` ${i.options.getString("reason")}` : ""}`)] }).catch(() => {});
    else await ch.send({ embeds: [new EmbedBuilder().setColor(COLORS.ok).setDescription("🔓 This channel is unlocked.")] }).catch(() => {});
    return replyOk(i, `${ch} ${locking ? "locked" : "unlocked"}.`);
  },
};

const lockdown: Command = {
  module: "moderation",
  summary: "Lock every public channel during a raid, then restore",
  data: new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Server-wide lockdown")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("start").setDescription("Lock every channel @everyone can talk in").addStringOption(reasonOpt))
    .addSubcommand((s) => s.setName("end").setDescription("Unlock the channels the lockdown locked")),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    await i.deferReply({ flags: 64 });
    if (i.options.getSubcommand() === "start") {
      const n = await startLockdown(i.guild, i.options.getString("reason") ?? `Started by ${i.user.username}`);
      return n === null ? replyErr(i, "A lockdown is already active. Use `/lockdown end`.") : replyOk(i, `Lockdown active: locked ${n} channel(s).`);
    }
    const n = await endLockdown(i.guild);
    return n === null ? replyErr(i, "No lockdown is active.") : replyOk(i, `Lockdown ended: unlocked ${n} channel(s).`);
  },
};

export const moderationCommands = [warn, timeout, untimeout, kick, ban, softban, unban, note, history, caseCmd, purge, lock, lockdown];
