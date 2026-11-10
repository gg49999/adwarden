import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type GuildMember,
} from "discord.js";
import { db, parseJson } from "../../db.js";
import type { Command, ComponentHandler } from "../../core/command.js";
import { COLORS } from "../../core/embeds.js";
import { formatDuration, parseDuration } from "../../core/duration.js";
import { getConfig, updateConfig } from "../../core/guildConfig.js";
import { canManageRole } from "../../core/permissions.js";
import { replyEmbed, replyErr, replyOk, respond } from "../../core/reply.js";
import { log } from "../../logger.js";
import { sendLog } from "../logging/logs.js";

// ---------------------------------------------------------------- /role

const pendingBulk = new Map<string, { roleId: string; add: boolean; filterRoleId?: string; userId: string; at: number }>();

function bulkTargets(members: Iterable<GuildMember>, roleId: string, add: boolean, filterRoleId?: string) {
  return [...members].filter((m) => !m.user.bot && (!filterRoleId || m.roles.cache.has(filterRoleId)) && m.roles.cache.has(roleId) !== add);
}

const role: Command = {
  module: "roles",
  summary: "Give, remove, or temporarily give roles; bulk role changes",
  data: new SlashCommandBuilder()
    .setName("role")
    .setDescription("Manage member roles")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s.setName("add").setDescription("Give a role")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("remove").setDescription("Remove a role")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("temp").setDescription("Give a role that is removed automatically")
        .addUserOption((o) => o.setName("user").setDescription("Member").setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
        .addStringOption((o) => o.setName("duration").setDescription("e.g. 1h, 7d").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("bulk").setDescription("Add or remove a role for many members (shows a preview first)")
        .addStringOption((o) => o.setName("action").setDescription("Add or remove").addChoices({ name: "add", value: "add" }, { name: "remove", value: "remove" }).setRequired(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role to add/remove").setRequired(true))
        .addRoleOption((o) => o.setName("only_with").setDescription("Only members who have this role (default: everyone)")),
    ),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    const r = i.options.getRole("role", true);
    const problem = canManageRole(i.guild, r.id, i.member);
    if (problem) return replyErr(i, problem);

    if (sub === "bulk") {
      await i.deferReply({ flags: 64 });
      const add = i.options.getString("action", true) === "add";
      const filterRoleId = i.options.getRole("only_with")?.id;
      const members = await i.guild.members.fetch();
      const targets = bulkTargets(members.values(), r.id, add, filterRoleId);
      if (!targets.length) return replyErr(i, "Nobody would change.");
      const key = `${i.guildId}:${i.id}`;
      pendingBulk.set(key, { roleId: r.id, add, filterRoleId, userId: i.user.id, at: Date.now() });
      return respond(i, {
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.warn)
            .setTitle("Bulk role preview")
            .setDescription(`This will **${add ? "add" : "remove"}** ${r} ${add ? "to" : "from"} **${targets.length}** member(s)${filterRoleId ? ` who have <@&${filterRoleId}>` : ""}. It takes about ${Math.ceil(targets.length / 5)}s.`),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`rolebulk:go:${i.id}`).setLabel(`Confirm (${targets.length})`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`rolebulk:cancel:${i.id}`).setLabel("Cancel").setStyle(ButtonStyle.Secondary),
          ),
        ],
      });
    }

    const member = await i.guild.members.fetch(i.options.getUser("user", true).id).catch(() => null);
    if (!member) return replyErr(i, "They aren't in this server.");
    if (sub === "add") {
      await member.roles.add(r, `By ${i.user.username}`);
      return replyOk(i, `Gave ${r} to ${member}.`);
    }
    if (sub === "remove") {
      await member.roles.remove(r, `By ${i.user.username}`);
      await db.tempRole.deleteMany({ where: { guildId: i.guildId, userId: member.id, roleId: r.id } });
      return replyOk(i, `Removed ${r} from ${member}.`);
    }
    if (sub === "temp") {
      const ms = parseDuration(i.options.getString("duration", true));
      if (!ms) return replyErr(i, "Invalid duration. Try `1h` or `7d`.");
      await member.roles.add(r, `Temp role by ${i.user.username} for ${formatDuration(ms)}`);
      await db.tempRole.deleteMany({ where: { guildId: i.guildId, userId: member.id, roleId: r.id } });
      await db.tempRole.create({ data: { guildId: i.guildId, userId: member.id, roleId: r.id, expiresAt: new Date(Date.now() + ms) } });
      return replyOk(i, `Gave ${r} to ${member} for ${formatDuration(ms)}.`);
    }
  },
};

export const roleBulkHandler: ComponentHandler = {
  prefix: "rolebulk",
  async handle(i, [action, id]) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    const key = `${i.guildId}:${id}`;
    const job = pendingBulk.get(key);
    pendingBulk.delete(key);
    if (!job || job.userId !== i.user.id || Date.now() - job.at > 5 * 60_000) return i.update({ content: "This preview expired.", embeds: [], components: [] });
    if (action === "cancel") return i.update({ content: "Cancelled.", embeds: [], components: [] });
    await i.update({ content: "Working…", embeds: [], components: [] });
    const members = await i.guild.members.fetch();
    const targets = bulkTargets(members.values(), job.roleId, job.add, job.filterRoleId);
    let done = 0;
    for (const m of targets) {
      try {
        if (job.add) await m.roles.add(job.roleId, `Bulk by ${i.user.username}`);
        else await m.roles.remove(job.roleId, `Bulk by ${i.user.username}`);
        done++;
      } catch (err) {
        log.debug("bulk role failed", err);
      }
    }
    await sendLog(i.guild, "mod", new EmbedBuilder().setColor(COLORS.info).setDescription(`👥 ${i.user} bulk-${job.add ? "added" : "removed"} <@&${job.roleId}> for ${done} member(s).`));
    return i.editReply({ content: `Done: ${done}/${targets.length} member(s) updated.` });
  },
};

// ---------------------------------------------------------------- /panel (button role panels)

interface PanelRole {
  roleId: string;
  label: string;
  emoji?: string;
}

function panelMessage(p: { id: string; title: string; description: string | null; roles: string; mode: string }) {
  const roles = parseJson<PanelRole[]>(p.roles, []);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle(p.title)
    .setDescription(`${p.description ?? ""}\n\n${roles.map((r) => `${r.emoji ?? "•"} <@&${r.roleId}>`).join("\n")}`.trim())
    .setFooter({ text: p.mode === "unique" ? "Pick one, picking another swaps it" : "Click to add or remove a role" });
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  roles.slice(0, 25).forEach((r, n) => {
    if (n % 5 === 0) rows.push(new ActionRowBuilder<ButtonBuilder>());
    const b = new ButtonBuilder().setCustomId(`rp:${p.id}:${r.roleId}`).setLabel(r.label).setStyle(ButtonStyle.Secondary);
    if (r.emoji) b.setEmoji(r.emoji);
    rows[rows.length - 1].addComponents(b);
  });
  return { embeds: [embed], components: rows, allowedMentions: { parse: [] } };
}

const panel: Command = {
  module: "roles",
  summary: "Self-assign role panels with buttons",
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Button role panels")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addSubcommand((s) =>
      s.setName("create").setDescription("Create a panel")
        .addStringOption((o) => o.setName("title").setDescription("Title").setRequired(true).setMaxLength(200))
        .addStringOption((o) => o.setName("description").setDescription("Description").setMaxLength(1500))
        .addStringOption((o) => o.setName("mode").setDescription("toggle = any number, unique = only one").addChoices({ name: "toggle", value: "toggle" }, { name: "unique", value: "unique" })),
    )
    .addSubcommand((s) =>
      s.setName("addrole").setDescription("Add a role button")
        .addStringOption((o) => o.setName("panel").setDescription("Panel").setRequired(true).setAutocomplete(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true))
        .addStringOption((o) => o.setName("label").setDescription("Button text (default: role name)").setMaxLength(80))
        .addStringOption((o) => o.setName("emoji").setDescription("Emoji")),
    )
    .addSubcommand((s) =>
      s.setName("removerole").setDescription("Remove a role button")
        .addStringOption((o) => o.setName("panel").setDescription("Panel").setRequired(true).setAutocomplete(true))
        .addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("send").setDescription("Post (or re-post) the panel")
        .addStringOption((o) => o.setName("panel").setDescription("Panel").setRequired(true).setAutocomplete(true))
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("delete").setDescription("Delete a panel").addStringOption((o) => o.setName("panel").setDescription("Panel").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List panels")),
  async autocomplete(i) {
    if (!i.inGuild()) return;
    const q = i.options.getFocused().toLowerCase();
    const panels = await db.rolePanel.findMany({ where: { guildId: i.guildId }, take: 50 });
    return i.respond(panels.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 25).map((p) => ({ name: p.title.slice(0, 100), value: p.id })));
  },
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    if (sub === "create") {
      const p = await db.rolePanel.create({
        data: { guildId: i.guildId, title: i.options.getString("title", true), description: i.options.getString("description"), mode: i.options.getString("mode") ?? "toggle" },
      });
      return replyOk(i, `Panel **${p.title}** created. Add roles with \`/panel addrole\`, then post it with \`/panel send\`.`);
    }
    if (sub === "list") {
      const panels = await db.rolePanel.findMany({ where: { guildId: i.guildId } });
      if (!panels.length) return replyErr(i, "No panels yet. Use `/panel create`.");
      return replyEmbed(i, new EmbedBuilder().setColor(COLORS.brand).setTitle("Role panels").setDescription(panels.map((p) => `• **${p.title}** · ${parseJson<PanelRole[]>(p.roles, []).length} role(s) · ${p.mode}${p.channelId ? ` · in <#${p.channelId}>` : " · not posted"}`).join("\n")));
    }
    const p = await db.rolePanel.findFirst({ where: { id: i.options.getString("panel", true), guildId: i.guildId } });
    if (!p) return replyErr(i, "Panel not found. Pick one from the list.");
    const roles = parseJson<PanelRole[]>(p.roles, []);

    if (sub === "addrole") {
      const r = i.options.getRole("role", true);
      const problem = canManageRole(i.guild, r.id, i.member);
      if (problem) return replyErr(i, problem);
      if (roles.length >= 25) return replyErr(i, "A panel can hold 25 roles.");
      const next = roles.filter((x) => x.roleId !== r.id);
      next.push({ roleId: r.id, label: i.options.getString("label") ?? r.name.slice(0, 80), emoji: i.options.getString("emoji") ?? undefined });
      await db.rolePanel.update({ where: { id: p.id }, data: { roles: JSON.stringify(next) } });
      await refreshPanel(i.guild, { ...p, roles: JSON.stringify(next) });
      return replyOk(i, `Added ${r} to **${p.title}**.`);
    }
    if (sub === "removerole") {
      const r = i.options.getRole("role", true);
      const next = roles.filter((x) => x.roleId !== r.id);
      await db.rolePanel.update({ where: { id: p.id }, data: { roles: JSON.stringify(next) } });
      await refreshPanel(i.guild, { ...p, roles: JSON.stringify(next) });
      return replyOk(i, `Removed ${r} from **${p.title}**.`);
    }
    if (sub === "send") {
      if (!roles.length) return replyErr(i, "Add at least one role first.");
      const ch = i.options.getChannel("channel", true);
      const channel = await i.guild.channels.fetch(ch.id).catch(() => null);
      if (!channel?.isSendable()) return replyErr(i, "I can't post there.");
      const msg = await channel.send(panelMessage(p));
      await db.rolePanel.update({ where: { id: p.id }, data: { channelId: channel.id, messageId: msg.id } });
      return replyOk(i, `Posted: ${msg.url}`);
    }
    if (sub === "delete") {
      await db.rolePanel.delete({ where: { id: p.id } });
      if (p.channelId && p.messageId) {
        const ch = await i.guild.channels.fetch(p.channelId).catch(() => null);
        if (ch?.isTextBased()) await ch.messages.delete(p.messageId).catch(() => {});
      }
      return replyOk(i, `Deleted **${p.title}**.`);
    }
  },
};

async function refreshPanel(guild: import("discord.js").Guild, p: { id: string; title: string; description: string | null; roles: string; mode: string; channelId: string | null; messageId: string | null }) {
  if (!p.channelId || !p.messageId) return;
  const ch = await guild.channels.fetch(p.channelId).catch(() => null);
  if (!ch?.isTextBased()) return;
  const msg = await ch.messages.fetch(p.messageId).catch(() => null);
  await msg?.edit(panelMessage(p)).catch(() => {});
}

export const panelHandler: ComponentHandler = {
  prefix: "rp",
  async handle(i, [panelId, roleId]) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    const p = await db.rolePanel.findUnique({ where: { id: panelId } });
    const roles = parseJson<PanelRole[]>(p?.roles, []);
    if (!p || !roles.some((r) => r.roleId === roleId)) return replyErr(i, "This button is no longer active.");
    const problem = canManageRole(i.guild, roleId);
    if (problem) return replyErr(i, `I can't assign that role right now. ${problem}`);
    const member = i.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, "Role panel");
      return replyOk(i, `Removed <@&${roleId}>.`);
    }
    if (p.mode === "unique") {
      const others = roles.map((r) => r.roleId).filter((id) => id !== roleId && member.roles.cache.has(id));
      if (others.length) await member.roles.remove(others, "Role panel (unique)");
    }
    await member.roles.add(roleId, "Role panel");
    return replyOk(i, `Gave you <@&${roleId}>.`);
  },
};

// ---------------------------------------------------------------- /autorole

const autorole: Command = {
  module: "roles",
  summary: "Roles given automatically on join, and roles restored on rejoin",
  data: new SlashCommandBuilder()
    .setName("autorole")
    .setDescription("Automatic roles")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("add").setDescription("Give this role to everyone who joins").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Stop giving this role on join").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand((s) => s.setName("delay").setDescription("Wait before giving join roles").addIntegerOption((o) => o.setName("seconds").setDescription("0-3600").setMinValue(0).setMaxValue(3600).setRequired(true)))
    .addSubcommand((s) => s.setName("persist").setDescription("Restore this role if a member leaves and rejoins (e.g. quarantine)").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand((s) => s.setName("unpersist").setDescription("Stop restoring this role").addRoleOption((o) => o.setName("role").setDescription("Role").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("Show automatic roles")),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    if (sub === "list") {
      const cfg = await getConfig(i.guildId);
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle("Automatic roles")
          .addFields(
            { name: `On join${cfg.autoRoleDelaySeconds ? ` (after ${cfg.autoRoleDelaySeconds}s)` : ""}`, value: cfg.autoRoleIds.map((r) => `<@&${r}>`).join(" ") || "—" },
            { name: "Restored on rejoin", value: cfg.persistRoleIds.map((r) => `<@&${r}>`).join(" ") || "—" },
          ),
      );
    }
    if (sub === "delay") {
      const s = i.options.getInteger("seconds", true);
      await updateConfig(i.guildId, (c) => void (c.autoRoleDelaySeconds = s));
      return replyOk(i, `Join roles are now given after ${s}s.`);
    }
    const r = i.options.getRole("role", true);
    const problem = canManageRole(i.guild, r.id, i.member);
    if (problem && (sub === "add" || sub === "persist")) return replyErr(i, problem);
    await updateConfig(i.guildId, (c) => {
      const list = sub === "add" || sub === "remove" ? c.autoRoleIds : c.persistRoleIds;
      const without = list.filter((x) => x !== r.id);
      const next = sub === "add" || sub === "persist" ? [...without, r.id] : without;
      if (sub === "add" || sub === "remove") c.autoRoleIds = next;
      else c.persistRoleIds = next;
    });
    const msg = { add: `New members get ${r}.`, remove: `New members no longer get ${r}.`, persist: `${r} is restored when members rejoin.`, unpersist: `${r} is no longer restored.` } as const;
    return replyOk(i, msg[sub as keyof typeof msg]);
  },
};

export const roleCommands = [role, panel, autorole];
