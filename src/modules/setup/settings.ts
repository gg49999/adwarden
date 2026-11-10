/**
 * /settings: an interactive, tabbed control panel (ephemeral, only the invoker sees it).
 *
 * Tabs: Overview · Ad rules · Word filter · Anti-raid · Channels
 * Every component's customId carries the state it needs (tab, target, page), so the
 * panel survives restarts and nothing is held in memory.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type InteractionUpdateOptions,
  type ModalSubmitInteraction,
} from "discord.js";
import { client } from "../../client.js";
import type { Command, ComponentHandler, ComponentInteraction } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { getConfig, updateConfig, type GuildConfig } from "../../core/guildConfig.js";
import { replyErr, respond } from "../../core/reply.js";
import {
  BOOLEAN_RULES,
  ChannelRulesSchema,
  EXTRA_NUMBER_RULES,
  LIMIT_RULES,
  LIST_RULES,
  PRESETS,
  presetRules,
  RULE_HELP,
  summarizeRules,
  type ChannelRules,
  type PresetName,
  type RuleKey,
} from "../ads/rules.js";
import {
  channelsUsingRuleset,
  createRuleset,
  findRuleset,
  getAdChannel,
  getAdRules,
  getRuleset,
  linkChannel,
  listAdChannels,
  listRulesets,
  saveRuleset,
  saveRulesForChannel,
  setAdChannel,
} from "../ads/store.js";
import { compileWords, findWord, parseWordList } from "../wordfilter/filter.js";

type Tab = "home" | "ads" | "words" | "raid" | "chan";
type Payload = Pick<InteractionUpdateOptions, "embeds" | "components"> & { content?: string };

const TABS: { id: Tab; label: string; emoji: string }[] = [
  { id: "home", label: "Overview", emoji: "🏠" },
  { id: "ads", label: "Ad rules", emoji: "📢" },
  { id: "words", label: "Word filter", emoji: "🔤" },
  { id: "raid", label: "Anti-raid", emoji: "🚨" },
  { id: "chan", label: "Channels", emoji: "📁" },
];

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;
const on = (b: boolean) => (b ? "🟢 on" : "⚫ off");

function tabRow(active: Tab) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    TABS.map((t) =>
      new ButtonBuilder()
        .setCustomId(`set:tab:${t.id}`)
        .setLabel(t.label)
        .setEmoji(t.emoji)
        .setStyle(t.id === active ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  );
}

// ======================================================================= Overview

const MODULES = [
  ["ads", "Ad checks", "Invite-aware rules in ad channels"],
  ["sticky", "Sticky messages", "Messages that stay at the bottom"],
  ["moderation", "Moderation", "Warns, escalation, cases"],
  ["roles", "Roles", "Join roles, panels, restored roles"],
  ["antiraid", "Anti-raid", "Scam links, spam, raid detection"],
  ["logging", "Logging", "Message and member logs"],
] as const;

async function homeTab(guildId: string): Promise<Payload> {
  const cfg = await getConfig(guildId);
  const ads = listAdChannels(guildId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("⚙️ Settings · Overview")
    .setDescription("Use the tabs above to change settings. Changes save as soon as you make them.")
    .addFields(
      { name: "Modules", value: MODULES.map(([k, n]) => `${cfg.modules[k] ? "🟢" : "⚫"} ${n}`).join("\n"), inline: true },
      {
        name: "At a glance",
        value: [
          `Ad channels: **${ads.length}**`,
          `Rulesets: **${listRulesets(guildId).length}**`,
          `Word filter: ${on(cfg.wordFilter.enabled)} · ${cfg.wordFilter.words.length} word(s)`,
          `Review queue: ${cfg.reviewChannelId ? `<#${cfg.reviewChannelId}>` : "off"}`,
          `Mod log: ${cfg.logChannels.mod ? `<#${cfg.logChannels.mod}>` : "not set"}`,
        ].join("\n"),
        inline: true,
      },
    );
  const modules = new StringSelectMenuBuilder()
    .setCustomId("set:home:modules")
    .setPlaceholder("Turn modules on or off")
    .setMinValues(0)
    .setMaxValues(MODULES.length)
    .addOptions(MODULES.map(([k, n, d]) => ({ label: n, value: k, description: d, default: cfg.modules[k] })));
  return { embeds: [embed], components: [tabRow("home"), new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modules)] };
}

// ======================================================================= Ad rules

/** target: "c<channelId>" for a channel, "r<rulesetId>" for a ruleset, or "" for none chosen */
interface Target {
  kind: "channel" | "ruleset" | "none";
  id: string;
}
const parseTarget = (t: string | undefined): Target =>
  t?.startsWith("c") ? { kind: "channel", id: t.slice(1) } : t?.startsWith("r") ? { kind: "ruleset", id: t.slice(1) } : { kind: "none", id: "" };
const targetKey = (t: Target) => (t.kind === "channel" ? `c${t.id}` : t.kind === "ruleset" ? `r${t.id}` : "");

function rulesFor(t: Target): ChannelRules | undefined {
  if (t.kind === "channel") return getAdRules(t.id);
  if (t.kind === "ruleset") return getRuleset(t.id)?.rules;
  return undefined;
}

async function saveRulesTarget(guildId: string, t: Target, rules: ChannelRules) {
  if (t.kind === "channel") return saveRulesForChannel(guildId, t.id, rules);
  if (t.kind === "ruleset") return saveRuleset(t.id, rules);
}

function targetLabel(t: Target): string {
  if (t.kind === "channel") {
    const rsId = getAdChannel(t.id)?.rulesetId;
    const rs = rsId ? getRuleset(rsId) : undefined;
    return rs ? `<#${t.id}> (follows ruleset **${rs.name}**: edits apply to all ${channelsUsingRuleset(rs.id).length} channel(s) using it)` : `<#${t.id}> (own rules)`;
  }
  if (t.kind === "ruleset") {
    const rs = getRuleset(t.id);
    const used = channelsUsingRuleset(t.id);
    return `Ruleset **${rs?.name}** · used by ${used.length ? used.map((c) => `<#${c}>`).join(" ") : "no channels yet"}`;
  }
  return "";
}

function rulesEmbed(t: Target, r: ChannelRules) {
  const fmt = (k: RuleKey) => {
    const v = r[k];
    if (Array.isArray(v)) return v.length ? truncate(v.join(", "), 200) : "—";
    if (typeof v === "boolean") return v ? "on" : "off";
    return v === 0 ? "off" : String(v);
  };
  const lines = (keys: readonly RuleKey[]) => keys.map((k) => `**${RULE_HELP[k].split(" (")[0]}:** ${fmt(k)}`).join("\n");
  return new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("📢 Settings · Ad rules")
    .setDescription(`Editing ${targetLabel(t)}\n\n${summarizeRules(r) || "No restrictions"}`)
    .addFields(
      { name: "Character limits", value: lines(LIMIT_RULES), inline: true },
      { name: "Timing & size", value: lines(["userCooldownMinutes", "serverCooldownMinutes", "minMemberAgeMinutes", "minServerMembers", "expiryDays"]), inline: true },
      { name: "Other numbers", value: lines(EXTRA_NUMBER_RULES), inline: true },
      { name: "Word lists", value: lines(LIST_RULES) },
      { name: "On violation", value: `**Action:** ${r.action.replace("_", " + ")}${r.warnOnViolation ? " · warn" : ""}${r.timeoutMinutesOnViolation ? ` · ${r.timeoutMinutesOnViolation}m timeout` : ""}` },
    );
}

async function adsTab(guildId: string, rawTarget?: string): Promise<Payload> {
  const channels = listAdChannels(guildId);
  const sets = listRulesets(guildId);
  let t = parseTarget(rawTarget);
  if (t.kind === "none" && channels[0]) t = { kind: "channel", id: channels[0].channelId };
  if (t.kind === "channel" && !getAdRules(t.id)) t = { kind: "none", id: "" };
  if (t.kind === "ruleset" && !getRuleset(t.id)) t = { kind: "none", id: "" };

  const targetOptions = [
    ...channels.slice(0, 15).map((c) => ({
      label: `#${truncate(nameOf(guildId, c.channelId), 80)}`,
      value: `c${c.channelId}`,
      description: c.ruleset ? `Follows ruleset: ${truncate(c.ruleset.name, 70)}` : "Own rules",
      emoji: "💬",
      default: t.kind === "channel" && t.id === c.channelId,
    })),
    ...sets.slice(0, 10).map((s) => ({
      label: `Ruleset: ${truncate(s.name, 80)}`,
      value: `r${s.id}`,
      description: `Used by ${channelsUsingRuleset(s.id).length} channel(s)`,
      emoji: "📚",
      default: t.kind === "ruleset" && t.id === s.id,
    })),
  ];

  const rows: ActionRowBuilder<any>[] = [tabRow("ads")];
  if (targetOptions.length) {
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId("set:ads:target").setPlaceholder("Choose a channel or ruleset to edit").addOptions(targetOptions)));
  }

  const r = rulesFor(t);
  if (!r) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle("📢 Settings · Ad rules")
      .setDescription("No ad channels yet. Add one below, or run `/setup`.\n\n**Rulesets** are named sets of restrictions you can share between channels. Change a ruleset once and every channel using it updates.");
    rows.push(
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder().setCustomId("set:ads:addchan").setPlaceholder("➕ Make a channel an ad channel").addChannelTypes(...TEXT).setMaxValues(1),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId("set:ads:newset:").setLabel("New ruleset").setEmoji("📚").setStyle(ButtonStyle.Success)),
    );
    return { embeds: [embed], components: rows };
  }

  const tk = targetKey(t);
  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`set:ads:bools:${tk}`)
        .setPlaceholder("Toggle rules (checked = on)")
        .setMinValues(0)
        .setMaxValues(BOOLEAN_RULES.length)
        .addOptions(BOOLEAN_RULES.map((k) => ({ label: RULE_HELP[k].slice(0, 100), value: k, default: r[k] }))),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`set:ads:action:${tk}`)
        .setPlaceholder("When a rule is broken…")
        .addOptions(
          { label: "Delete and DM the reason", value: "delete_dm", default: r.action === "delete_dm" },
          { label: "Delete quietly", value: "delete", default: r.action === "delete" },
          { label: "Send to the review queue", value: "review", default: r.action === "review" },
          { label: "Only log it (keep the message)", value: "log", default: r.action === "log" },
        ),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`set:ads:m:limits:${tk}`).setLabel("Limits").setEmoji("📏").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`set:ads:m:timing:${tk}`).setLabel("Timing").setEmoji("⏱️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`set:ads:m:lists:${tk}`).setLabel("Word lists").setEmoji("📝").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`set:ads:more:${tk}`).setLabel("More…").setEmoji("➕").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [rulesEmbed(t, r)], components: rows };
}

/** Second page of the Ad rules tab: rulesets, presets, adding/linking channels. */
function adsMore(guildId: string, rawTarget: string): Payload {
  const t = parseTarget(rawTarget);
  const tk = targetKey(t);
  const sets = listRulesets(guildId);
  const rows: ActionRowBuilder<any>[] = [tabRow("ads")];
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("📢 Ad rules · More")
    .setDescription(
      `Editing ${targetLabel(t) || "nothing selected"}\n\n` +
        "• **Apply a preset** to overwrite these rules with Strict / Standard / Relaxed.\n" +
        "• **Link to a ruleset** so a channel shares rules with others (channels only).\n" +
        "• **Save as ruleset** copies these rules into a new named ruleset.\n" +
        "• **Extra numbers** covers invites per ad, caps % and auto-timeouts.",
    );
  rows.push(
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`set:ads:preset:${tk}`)
        .setPlaceholder("Apply a preset…")
        .addOptions(Object.keys(PRESETS).map((p) => ({ label: p[0].toUpperCase() + p.slice(1), value: p, description: truncate(summarizeRules(presetRules(p as PresetName)), 100) }))),
    ),
  );
  if (t.kind === "channel" && sets.length) {
    const current = getAdChannel(t.id)?.rulesetId;
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`set:ads:link:${tk}`)
          .setPlaceholder("Link this channel to a ruleset…")
          .addOptions([
            { label: "Use its own rules (unlink)", value: "-", emoji: "💬", default: !current },
            ...sets.slice(0, 24).map((s) => ({ label: truncate(s.name, 100), value: s.id, emoji: "📚", default: current === s.id })),
          ]),
      ),
    );
  }
  rows.push(
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId("set:ads:addchan").setPlaceholder("➕ Make another channel an ad channel").addChannelTypes(...TEXT).setMaxValues(1),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`set:ads:newset:${tk}`).setLabel(t.kind === "none" ? "New ruleset" : "Save as ruleset").setEmoji("📚").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`set:ads:m:extra:${tk}`).setLabel("Extra numbers").setEmoji("🔢").setStyle(ButtonStyle.Secondary).setDisabled(t.kind === "none"),
      new ButtonBuilder().setCustomId(`set:tab:ads:${tk}`).setLabel("Back").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
    ),
  );
  return { embeds: [embed], components: rows };
}

/** Only IDs that still exist (Discord rejects menus that default to deleted channels/roles). */
const liveChannels = (g: string, ids: string[]) => ids.filter((id) => client.guilds.cache.get(g)?.channels.cache.has(id));
const liveRoles = (g: string, ids: string[]) => ids.filter((id) => client.guilds.cache.get(g)?.roles.cache.has(id));
const nameOf = (guildId: string, channelId: string) => client.guilds.cache.get(guildId)?.channels.cache.get(channelId)?.name ?? channelId;

const MODAL_FIELDS: Record<string, { title: string; keys: readonly RuleKey[] }> = {
  limits: { title: "Character limits (0 = no limit)", keys: LIMIT_RULES },
  timing: { title: "Timing & server size", keys: ["userCooldownMinutes", "serverCooldownMinutes", "minMemberAgeMinutes", "minServerMembers", "expiryDays"] },
  extra: { title: "Extra numbers", keys: EXTRA_NUMBER_RULES },
  lists: { title: "Word lists (comma separated)", keys: LIST_RULES },
};

function rulesModal(group: string, tk: string, r: ChannelRules) {
  const g = MODAL_FIELDS[group];
  const modal = new ModalBuilder().setCustomId(`set:adsm:${group}:${tk}`).setTitle(g.title);
  for (const k of g.keys) {
    const v = r[k];
    const isList = Array.isArray(v);
    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(k)
          .setLabel(truncate(RULE_HELP[k], 45))
          .setStyle(isList ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(isList ? 2000 : 6)
          .setValue(isList ? (v as string[]).join(", ") : String(v))
          .setPlaceholder(isList ? (k === "blockedWords" ? "free nitro, scam*, *robux*" : "leave empty for none") : "0"),
      ),
    );
  }
  return modal;
}

// ======================================================================= Word filter

async function wordsTab(guildId: string, page: "main" | "more" = "main", notice?: string): Promise<Payload> {
  const cfg = await getConfig(guildId);
  const wf = cfg.wordFilter;
  const scopeText = wf.scope === "all" ? "every channel" : wf.scope === "ads" ? "ad channels only" : wf.channelIds.length ? wf.channelIds.map((c) => `<#${c}>`).join(" ") : "*no channels picked yet*";
  const actionText = { delete: "delete" + (wf.dmUser ? " + DM" : ""), delete_warn: "delete + warn", delete_timeout: `delete + ${wf.timeoutMinutes}m timeout`, log: "log only" }[wf.action];
  const preview = wf.words.length ? truncate(wf.words.map((w) => `||${w}||`).join(", "), 1000) : "*No words yet. Press **Add words**.*";
  const embed = new EmbedBuilder()
    .setColor(wf.enabled ? COLORS.ok : COLORS.muted)
    .setTitle(`🔤 Settings · Word filter ${wf.enabled ? "(on)" : "(off)"}`)
    .setDescription(
      (notice ? `${notice}\n\n` : "") +
        "Removes messages containing words you list. It also catches **l33tsp34k**, s p a c e d  letters, stretched letters (freeeee) and look-alike characters.\n" +
        "Syntax: `word` whole word · `word*` starts with · `*word` ends with · `*word*` anywhere.",
    )
    .addFields(
      { name: "Applies to", value: scopeText, inline: true },
      { name: "Action", value: actionText, inline: true },
      { name: "Exempt", value: [wf.exemptStaff ? "staff" : "", ...wf.exemptRoleIds.map((r) => `<@&${r}>`), ...wf.exemptChannelIds.map((c) => `<#${c}>`)].filter(Boolean).join(" ") || "nobody", inline: true },
      { name: `Words (${wf.words.length})`, value: preview },
    );

  const rows: ActionRowBuilder<any>[] = [tabRow("words")];
  if (page === "main") {
    rows.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("set:words:toggle").setLabel(wf.enabled ? "Turn off" : "Turn on").setStyle(wf.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId("set:words:add").setLabel("Add words").setEmoji("➕").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("set:words:remove").setLabel("Remove").setEmoji("➖").setStyle(ButtonStyle.Secondary).setDisabled(!wf.words.length),
        new ButtonBuilder().setCustomId("set:words:test").setLabel("Test").setEmoji("🧪").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("set:words:page:more").setLabel("Options").setEmoji("⚙️").setStyle(ButtonStyle.Secondary),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:words:action")
          .setPlaceholder("When a filtered word is found…")
          .addOptions(
            { label: "Delete the message", value: "delete", default: wf.action === "delete" },
            { label: "Delete + warn (counts toward escalation)", value: "delete_warn", default: wf.action === "delete_warn" },
            { label: "Delete + timeout", value: "delete_timeout", default: wf.action === "delete_timeout" },
            { label: "Only log it", value: "log", default: wf.action === "log" },
          ),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:words:scope")
          .setPlaceholder("Where the filter applies")
          .addOptions(
            { label: "Every channel", value: "all", default: wf.scope === "all" },
            { label: "Ad channels only", value: "ads", default: wf.scope === "ads" },
            { label: "Only channels I pick", value: "selected", default: wf.scope === "selected" },
          ),
      ),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        wf.scope === "selected"
          ? new ChannelSelectMenuBuilder().setCustomId("set:words:chans").setPlaceholder("Channels to filter").addChannelTypes(...TEXT).setMinValues(0).setMaxValues(25).setDefaultChannels(liveChannels(guildId, wf.channelIds))
          : new ChannelSelectMenuBuilder().setCustomId("set:words:exch").setPlaceholder("Channels to skip (exempt)").addChannelTypes(...TEXT).setMinValues(0).setMaxValues(25).setDefaultChannels(liveChannels(guildId, wf.exemptChannelIds)),
      ),
    );
  } else {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:words:opts")
          .setPlaceholder("Options (checked = on)")
          .setMinValues(0)
          .setMaxValues(5)
          .addOptions(
            { label: "Catch l33tspeak (0→o, 3→e, @→a…)", value: "leet", default: wf.leet },
            { label: "Catch spaced/stretched letters", value: "spacing", default: wf.spacing },
            { label: "DM the user why it was removed", value: "dmUser", default: wf.dmUser },
            { label: "Staff (Manage Messages) are exempt", value: "exemptStaff", default: wf.exemptStaff },
            { label: "Also check edited messages", value: "checkEdits", default: wf.checkEdits },
          ),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder().setCustomId("set:words:exroles").setPlaceholder("Roles that are exempt").setMinValues(0).setMaxValues(25).setDefaultRoles(liveRoles(guildId, wf.exemptRoleIds)),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("set:words:timeout").setLabel(`Timeout length: ${wf.timeoutMinutes}m`).setEmoji("⏳").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("set:words:clear").setLabel("Clear all words").setEmoji("🗑️").setStyle(ButtonStyle.Danger).setDisabled(!wf.words.length),
        new ButtonBuilder().setCustomId("set:words:page:main").setLabel("Back").setEmoji("↩️").setStyle(ButtonStyle.Secondary),
      ),
    );
  }
  return { embeds: [embed], components: rows };
}

function textModal(id: string, title: string, label: string, opts: { value?: string; placeholder?: string; long?: boolean; max?: number } = {}) {
  const input = new TextInputBuilder()
    .setCustomId("v")
    .setLabel(label)
    .setStyle(opts.long ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(opts.max ?? 4000);
  if (opts.value) input.setValue(opts.value);
  if (opts.placeholder) input.setPlaceholder(opts.placeholder);
  return new ModalBuilder().setCustomId(id).setTitle(title).addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

// ======================================================================= Anti-raid

async function raidTab(guildId: string): Promise<Payload> {
  const cfg = await getConfig(guildId);
  const ar = cfg.antiraid;
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("🚨 Settings · Anti-raid")
    .addFields(
      { name: "New accounts", value: ar.minAccountAgeDays ? `Younger than **${ar.minAccountAgeDays}d** → ${ar.youngAccountAction}${ar.youngAccountAction === "quarantine" ? ` (${ar.quarantineRoleId ? `<@&${ar.quarantineRoleId}>` : "⚠️ no role set"})` : ""}` : "No minimum age", inline: true },
      { name: "Raid detection", value: ar.joinBurstCount ? `${ar.joinBurstCount} joins in ${ar.joinBurstSeconds}s → alert${ar.autoLockdown ? " + lockdown" : ""}` : "off", inline: true },
      { name: "Spam", value: `Scam links: ${ar.scamLinks ? ar.scamAction.replace(/_/g, " + ") : "off"}\nMax mentions: ${ar.maxMentions || "off"}\nCross-channel spam: ${on(ar.crossChannelSpam)}`, inline: true },
    );
  return {
    embeds: [embed],
    components: [
      tabRow("raid"),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:raid:bools")
          .setPlaceholder("Toggles (checked = on)")
          .setMinValues(0)
          .setMaxValues(3)
          .addOptions(
            { label: "Block scam / phishing links", value: "scamLinks", default: ar.scamLinks },
            { label: "Lock down automatically on a raid", value: "autoLockdown", default: ar.autoLockdown },
            { label: "Catch the same message across channels", value: "crossChannelSpam", default: ar.crossChannelSpam },
          ),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:raid:young")
          .setPlaceholder("Accounts that are too new…")
          .addOptions(
            { label: "Just log them", value: "log", default: ar.youngAccountAction === "log" },
            { label: "Give them the quarantine role", value: "quarantine", default: ar.youngAccountAction === "quarantine" },
            { label: "Kick them", value: "kick", default: ar.youngAccountAction === "kick" },
          ),
      ),
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
        new RoleSelectMenuBuilder().setCustomId("set:raid:qrole").setPlaceholder("Quarantine role").setMinValues(0).setMaxValues(1).setDefaultRoles(liveRoles(guildId, ar.quarantineRoleId ? [ar.quarantineRoleId] : [])),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("set:raid:nums").setLabel("Numbers").setEmoji("🔢").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("set:raid:scam")
          .setLabel(`Scam link action: ${ar.scamAction.replace(/_/g, " + ")}`)
          .setEmoji("🔁")
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

// ======================================================================= Channels

const CHANNEL_SLOTS = [
  ["mod", "Mod log", "Warns, bans, anti-spam actions"],
  ["ads", "Ad log", "Removed/flagged ads, cleanup"],
  ["messages", "Message log", "Edits and deletes"],
  ["members", "Member log", "Joins and leaves"],
  ["review", "Review queue", "Ads waiting for approval"],
  ["appeal", "Ban appeals", "Appeals from banned users"],
  ["report", "DM-ad reports", "From /report-dm"],
] as const;
type Slot = (typeof CHANNEL_SLOTS)[number][0];

function slotValue(cfg: GuildConfig, s: Slot) {
  if (s === "review") return cfg.reviewChannelId;
  if (s === "appeal") return cfg.appealChannelId;
  if (s === "report") return cfg.reportChannelId;
  return cfg.logChannels[s];
}

async function chanTab(guildId: string, slot: Slot = "mod"): Promise<Payload> {
  const cfg = await getConfig(guildId);
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("📁 Settings · Channels")
    .setDescription(CHANNEL_SLOTS.map(([k, n]) => `${k === slot ? "▶" : "•"} **${n}:** ${slotValue(cfg, k) ? `<#${slotValue(cfg, k)}>` : "—"}`).join("\n"));
  const current = slotValue(cfg, slot);
  return {
    embeds: [embed],
    components: [
      tabRow("chan"),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("set:chan:slot")
          .setPlaceholder("Which channel to set")
          .addOptions(CHANNEL_SLOTS.map(([k, n, d]) => ({ label: n, value: k, description: d, default: k === slot }))),
      ),
      new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`set:chan:pick:${slot}`)
          .setPlaceholder(`Set the ${CHANNEL_SLOTS.find((s) => s[0] === slot)![1]}`)
          .addChannelTypes(...TEXT)
          .setMinValues(0)
          .setMaxValues(1)
          .setDefaultChannels(liveChannels(guildId, current ? [current] : [])),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("set:chan:all").setLabel("Use the mod log for every log").setStyle(ButtonStyle.Secondary).setDisabled(!cfg.logChannels.mod),
      ),
    ],
  };
}

// ======================================================================= Command + router

async function render(guildId: string, tab: Tab, arg?: string): Promise<Payload> {
  if (tab === "ads") return adsTab(guildId, arg);
  if (tab === "words") return wordsTab(guildId);
  if (tab === "raid") return raidTab(guildId);
  if (tab === "chan") return chanTab(guildId);
  return homeTab(guildId);
}

const settings: Command = {
  module: "general",
  summary: "Tabbed control panel: ad rules & rulesets, word filter, anti-raid, channels",
  data: new SlashCommandBuilder()
    .setName("settings")
    .setDescription("Open the settings panel")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((o) =>
      o.setName("tab").setDescription("Open on this tab").addChoices(...TABS.map((t) => ({ name: t.label, value: t.id }))),
    ),
  async execute(i: ChatInputCommandInteraction) {
    if (!i.inCachedGuild()) return;
    const tab = (i.options.getString("tab") as Tab | null) ?? "home";
    return i.reply({ ...(await render(i.guildId, tab)), flags: 64 } as never);
  },
};

/** Applies a change, then re-renders the panel in place. */
async function apply(i: ComponentInteraction, payload: Payload) {
  if (i.isModalSubmit()) {
    if (i.isFromMessage()) return i.update(payload as never);
    return respond(i, payload as never);
  }
  return i.update(payload as never);
}

function readNumber(i: ModalSubmitInteraction, key: string): number | string {
  const raw = i.fields.getTextInputValue(key).trim();
  if (raw === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : `"${raw}" isn't a whole number (for ${RULE_HELP[key as RuleKey] ?? key}).`;
}

export const settingsHandler: ComponentHandler = {
  prefix: "set",
  async handle(i, args) {
    if (!i.inCachedGuild()) return;
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageGuild)) return replyErr(i, "You need Manage Server to change settings.");
    const g = i.guildId;
    const [area, action, ...rest] = args;

    // ---- tabs
    if (area === "tab" && i.isButton()) return i.update((await render(g, action as Tab, rest[0])) as never);

    // ---- overview
    if (area === "home" && action === "modules" && i.isStringSelectMenu()) {
      await updateConfig(g, (c) => {
        for (const [k] of MODULES) c.modules[k] = i.values.includes(k);
      });
      return i.update((await homeTab(g)) as never);
    }

    // ---- ad rules
    if (area === "ads") {
      if (action === "target" && i.isStringSelectMenu()) return i.update((await adsTab(g, i.values[0])) as never);
      if (action === "addchan" && i.isChannelSelectMenu()) {
        const id = i.values[0];
        if (!getAdRules(id)) await setAdChannel(g, id, presetRules("standard"));
        return i.update((await adsTab(g, `c${id}`)) as never);
      }
      if (action === "more" && i.isButton()) return i.update(adsMore(g, rest[0] ?? "") as never);
      if (action === "newset" && i.isButton()) {
        return i.showModal(textModal(`set:adsnew:${rest[0] ?? ""}`, "New ruleset", "Name", { placeholder: "e.g. Big servers, Gaming, Partners", max: 50 }));
      }

      const t = parseTarget(rest[rest.length - 1]);
      const r = rulesFor(t);
      if (!r) return replyErr(i, "That channel or ruleset no longer exists.");

      if (action === "bools" && i.isStringSelectMenu()) {
        const next = { ...r };
        for (const k of BOOLEAN_RULES) next[k] = i.values.includes(k);
        await saveRulesTarget(g, t, ChannelRulesSchema.parse(next));
        return i.update((await adsTab(g, targetKey(t))) as never);
      }
      if (action === "action" && i.isStringSelectMenu()) {
        await saveRulesTarget(g, t, ChannelRulesSchema.parse({ ...r, action: i.values[0] }));
        return i.update((await adsTab(g, targetKey(t))) as never);
      }
      if (action === "preset" && i.isStringSelectMenu()) {
        await saveRulesTarget(g, t, presetRules(i.values[0] as PresetName));
        return i.update((await adsTab(g, targetKey(t))) as never);
      }
      if (action === "link" && i.isStringSelectMenu() && t.kind === "channel") {
        await linkChannel(g, t.id, i.values[0] === "-" ? null : i.values[0]);
        return i.update((await adsTab(g, targetKey(t))) as never);
      }
      if (action === "m" && i.isButton()) return i.showModal(rulesModal(rest[0], targetKey(t), r));
    }

    if (area === "adsm" && i.isModalSubmit()) {
      const [group, tk] = [action, rest[0]];
      const t = parseTarget(tk);
      const r = rulesFor(t);
      const spec = MODAL_FIELDS[group];
      if (!r || !spec) return replyErr(i, "That channel or ruleset no longer exists.");
      const next: Record<string, unknown> = { ...r };
      for (const k of spec.keys) {
        if (Array.isArray(r[k])) {
          next[k] = k === "blockedWords" ? parseWordList(i.fields.getTextInputValue(k)) : i.fields.getTextInputValue(k).split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        } else {
          const n = readNumber(i, k);
          if (typeof n === "string") return replyErr(i, n);
          next[k] = n;
        }
      }
      const parsed = ChannelRulesSchema.safeParse(next);
      if (!parsed.success) return replyErr(i, `Couldn't save: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
      await saveRulesTarget(g, t, parsed.data);
      return apply(i, await adsTab(g, tk));
    }

    if (area === "adsnew" && i.isModalSubmit()) {
      const name = i.fields.getTextInputValue("v").trim().slice(0, 50);
      if (!name) return replyErr(i, "Give it a name.");
      if (findRuleset(g, name)) return replyErr(i, `A ruleset called **${name}** already exists.`);
      if (listRulesets(g).length >= 10) return replyErr(i, "A server can have up to 10 rulesets.");
      const from = rulesFor(parseTarget(action));
      const rs = await createRuleset(g, name, from ?? presetRules("standard"));
      return apply(i, await adsTab(g, `r${rs.id}`));
    }

    // ---- word filter
    if (area === "words") {
      if (action === "page" && i.isButton()) return i.update((await wordsTab(g, rest[0] as "main" | "more")) as never);
      if (action === "toggle" && i.isButton()) {
        const c = await updateConfig(g, (c) => void (c.wordFilter.enabled = !c.wordFilter.enabled));
        const hint = c.wordFilter.enabled && !c.wordFilter.words.length ? "✅ Turned on. Add some words so it has something to catch." : undefined;
        return i.update((await wordsTab(g, "main", hint)) as never);
      }
      if (action === "add" && i.isButton())
        return i.showModal(textModal("set:wordsm:add", "Add filtered words", "Words or phrases, comma or line separated", { long: true, placeholder: "badword, scam*, *nitro*, free robux" }));
      if (action === "remove" && i.isButton()) {
        const cfg = await getConfig(g);
        return i.showModal(textModal("set:wordsm:remove", "Remove words", "Words to remove, comma separated", { long: true, placeholder: truncate(cfg.wordFilter.words.slice(0, 15).join(", "), 100) }));
      }
      if (action === "test" && i.isButton()) return i.showModal(textModal("set:wordsm:test", "Test the filter", "A message to test", { long: true, max: 2000 }));
      if (action === "timeout" && i.isButton()) {
        const cfg = await getConfig(g);
        return i.showModal(textModal("set:wordsm:timeout", "Timeout length", "Minutes (1-40320)", { value: String(cfg.wordFilter.timeoutMinutes), max: 5 }));
      }
      if (action === "clear" && i.isButton()) {
        await updateConfig(g, (c) => void (c.wordFilter.words = []));
        return i.update((await wordsTab(g, "more", "🗑️ All words cleared.")) as never);
      }
      if (action === "action" && i.isStringSelectMenu()) {
        await updateConfig(g, (c) => void (c.wordFilter.action = i.values[0] as GuildConfig["wordFilter"]["action"]));
        return i.update((await wordsTab(g)) as never);
      }
      if (action === "scope" && i.isStringSelectMenu()) {
        await updateConfig(g, (c) => void (c.wordFilter.scope = i.values[0] as GuildConfig["wordFilter"]["scope"]));
        return i.update((await wordsTab(g)) as never);
      }
      if (action === "chans" && i.isChannelSelectMenu()) {
        await updateConfig(g, (c) => void (c.wordFilter.channelIds = i.values));
        return i.update((await wordsTab(g)) as never);
      }
      if (action === "exch" && i.isChannelSelectMenu()) {
        await updateConfig(g, (c) => void (c.wordFilter.exemptChannelIds = i.values));
        return i.update((await wordsTab(g)) as never);
      }
      if (action === "exroles" && i.isRoleSelectMenu()) {
        await updateConfig(g, (c) => void (c.wordFilter.exemptRoleIds = i.values));
        return i.update((await wordsTab(g, "more")) as never);
      }
      if (action === "opts" && i.isStringSelectMenu()) {
        await updateConfig(g, (c) => {
          for (const k of ["leet", "spacing", "dmUser", "exemptStaff", "checkEdits"] as const) c.wordFilter[k] = i.values.includes(k);
        });
        return i.update((await wordsTab(g, "more")) as never);
      }
    }

    if (area === "wordsm" && i.isModalSubmit()) {
      const v = i.fields.getTextInputValue("v");
      if (action === "add") {
        const add = parseWordList(v);
        if (!add.length) return replyErr(i, "Nothing to add. Words need at least 2 letters.");
        let added = 0;
        await updateConfig(g, (c) => {
          const set = new Set(c.wordFilter.words);
          for (const w of add) if (!set.has(w) && set.size < 1000) (set.add(w), added++);
          c.wordFilter.words = [...set];
        });
        return apply(i, await wordsTab(g, "main", `➕ Added ${added} word(s).`));
      }
      if (action === "remove") {
        const del = new Set(parseWordList(v));
        let removed = 0;
        await updateConfig(g, (c) => {
          const before = c.wordFilter.words.length;
          c.wordFilter.words = c.wordFilter.words.filter((w) => !del.has(w));
          removed = before - c.wordFilter.words.length;
        });
        return apply(i, await wordsTab(g, "main", `➖ Removed ${removed} word(s).`));
      }
      if (action === "timeout") {
        const n = Number(v.trim());
        if (!Number.isInteger(n) || n < 1 || n > 40320) return replyErr(i, "Use a whole number of minutes between 1 and 40320 (28 days).");
        await updateConfig(g, (c) => void (c.wordFilter.timeoutMinutes = n));
        return apply(i, await wordsTab(g, "more"));
      }
      if (action === "test") {
        const cfg = await getConfig(g);
        const hit = findWord(v, compileWords(cfg.wordFilter.words), { leet: cfg.wordFilter.leet, spacing: cfg.wordFilter.spacing });
        const note = hit ? `🧪 That message **would be caught** by \`${hit}\`${cfg.wordFilter.enabled ? "" : " (the filter is off right now)"}.` : "🧪 That message **would pass**.";
        return apply(i, await wordsTab(g, "main", note));
      }
    }

    // ---- anti-raid
    if (area === "raid") {
      if (action === "bools" && i.isStringSelectMenu()) {
        await updateConfig(g, (c) => {
          for (const k of ["scamLinks", "autoLockdown", "crossChannelSpam"] as const) c.antiraid[k] = i.values.includes(k);
        });
        return i.update((await raidTab(g)) as never);
      }
      if (action === "young" && i.isStringSelectMenu()) {
        await updateConfig(g, (c) => void (c.antiraid.youngAccountAction = i.values[0] as GuildConfig["antiraid"]["youngAccountAction"]));
        return i.update((await raidTab(g)) as never);
      }
      if (action === "qrole" && i.isRoleSelectMenu()) {
        await updateConfig(g, (c) => void (c.antiraid.quarantineRoleId = i.values[0]));
        return i.update((await raidTab(g)) as never);
      }
      if (action === "scam" && i.isButton()) {
        const order = ["delete", "delete_timeout", "delete_ban"] as const;
        await updateConfig(g, (c) => void (c.antiraid.scamAction = order[(order.indexOf(c.antiraid.scamAction) + 1) % order.length]));
        return i.update((await raidTab(g)) as never);
      }
      if (action === "nums" && i.isButton()) {
        const ar = (await getConfig(g)).antiraid;
        const field = (id: string, label: string, v: number) =>
          new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setValue(String(v)));
        return i.showModal(
          new ModalBuilder()
            .setCustomId("set:raidm:nums")
            .setTitle("Anti-raid numbers (0 = off)")
            .addComponents(
              field("minAccountAgeDays", "Minimum account age (days)", ar.minAccountAgeDays),
              field("joinBurstCount", "Raid alert: this many joins…", ar.joinBurstCount),
              field("joinBurstSeconds", "…within this many seconds", ar.joinBurstSeconds),
              field("maxMentions", "Max mentions in one message", ar.maxMentions),
            ),
        );
      }
    }
    if (area === "raidm" && i.isModalSubmit()) {
      const vals: Record<string, number> = {};
      for (const k of ["minAccountAgeDays", "joinBurstCount", "joinBurstSeconds", "maxMentions"]) {
        const n = readNumber(i, k);
        if (typeof n === "string") return replyErr(i, n);
        vals[k] = n;
      }
      if (vals.joinBurstSeconds < 1) vals.joinBurstSeconds = 10;
      try {
        await updateConfig(g, (c) => Object.assign(c.antiraid, vals));
      } catch {
        return replyErr(i, "One of those numbers is out of range (account age max 365 days).");
      }
      return apply(i, await raidTab(g));
    }

    // ---- channels
    if (area === "chan") {
      if (action === "slot" && i.isStringSelectMenu()) return i.update((await chanTab(g, i.values[0] as Slot)) as never);
      if (action === "pick" && i.isChannelSelectMenu()) {
        const slot = rest[0] as Slot;
        const id = i.values[0];
        await updateConfig(g, (c) => {
          if (slot === "review") c.reviewChannelId = id;
          else if (slot === "appeal") c.appealChannelId = id;
          else if (slot === "report") c.reportChannelId = id;
          else c.logChannels[slot] = id;
        });
        return i.update((await chanTab(g, slot)) as never);
      }
      if (action === "all" && i.isButton()) {
        await updateConfig(g, (c) => {
          const m = c.logChannels.mod;
          c.logChannels = { mod: m, ads: m, messages: m, members: m };
        });
        return i.update((await chanTab(g)) as never);
      }
    }
  },
};

export const settingsCommands = [settings];
