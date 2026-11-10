import {
  AttachmentBuilder,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../../core/command.js";
import { COLORS } from "../../core/embeds.js";
import { formatDuration, parseDuration } from "../../core/duration.js";
import { getConfig, replaceConfig, updateConfig, GuildConfigSchema, type GuildConfig } from "../../core/guildConfig.js";
import { replyEmbed, replyErr, replyOk } from "../../core/reply.js";
import { parseRules } from "../ads/rules.js";
import { createRuleset, findRuleset, linkChannel, listAdChannels, listRulesets, saveRuleset, setAdChannel } from "../ads/store.js";

const CHANNEL_KEYS = {
  mod_log: "Mod log",
  ad_log: "Ad log",
  message_log: "Message log (edits/deletes)",
  member_log: "Member log (joins/leaves)",
  review: "Ad review queue",
  appeal: "Ban appeals",
  report: "DM-ad reports",
} as const;

const ADS_KEYS = ["exemptStaff", "deleteOnLeave", "leaveGraceMinutes", "deleteDeadInvites", "revalidateHours", "dmOnRemoval", "trustedThreshold", "trustedRoleId"] as const;
const RAID_KEYS = [
  "minAccountAgeDays", "youngAccountAction", "quarantineRoleId", "joinBurstCount", "joinBurstSeconds",
  "autoLockdown", "scamLinks", "scamAction", "maxMentions", "crossChannelSpam",
] as const;
const MODULES = ["ads", "sticky", "moderation", "roles", "antiraid", "logging"] as const;

/** Parses a typed value according to the current value's type. Snowflake fields accept mentions or "none". */
function coerce(current: unknown, raw: string, key: string): unknown {
  const v = raw.trim();
  if (key.endsWith("Id")) return /^none|off|-$/i.test(v) ? undefined : v.replace(/\D/g, "");
  if (typeof current === "boolean" || current === undefined && /^(true|false|on|off)$/i.test(v)) return /^(true|on|yes|1)$/i.test(v);
  if (typeof current === "number") return Number(v);
  return v;
}

const config: Command = {
  module: "general",
  summary: "View and change server settings; export/import them",
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Server settings")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) => s.setName("view").setDescription("Show all settings"))
    .addSubcommand((s) =>
      s
        .setName("channel")
        .setDescription("Set a log/review/appeal/report channel")
        .addStringOption((o) => o.setName("type").setDescription("Which channel").setRequired(true).addChoices(...Object.entries(CHANNEL_KEYS).map(([value, name]) => ({ name, value }))))
        .addChannelOption((o) => o.setName("channel").setDescription("Leave empty to clear")),
    )
    .addSubcommand((s) =>
      s
        .setName("module")
        .setDescription("Turn a module on or off")
        .addStringOption((o) => o.setName("name").setDescription("Module").setRequired(true).addChoices(...MODULES.map((m) => ({ name: m, value: m }))))
        .addBooleanOption((o) => o.setName("enabled").setDescription("On or off").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("ads")
        .setDescription("Ad cleanup and trust settings")
        .addStringOption((o) => o.setName("setting").setDescription("Setting").setRequired(true).addChoices(...ADS_KEYS.map((k) => ({ name: k, value: k }))))
        .addStringOption((o) => o.setName("value").setDescription("New value (on/off, number, role ID, or none)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("antiraid")
        .setDescription("Anti-raid and anti-scam settings")
        .addStringOption((o) => o.setName("setting").setDescription("Setting").setRequired(true).addChoices(...RAID_KEYS.map((k) => ({ name: k, value: k }))))
        .addStringOption((o) => o.setName("value").setDescription("New value").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("escalation")
        .setDescription("Automatic punishments for repeated warnings")
        .addBooleanOption((o) => o.setName("enabled").setDescription("On or off"))
        .addStringOption((o) => o.setName("steps").setDescription('e.g. "3:timeout:1h, 5:timeout:1d, 7:ban"')),
    )
    .addSubcommand((s) => s.setName("export").setDescription("Download settings + ad channel rules as a file"))
    .addSubcommand((s) =>
      s.setName("import").setDescription("Load settings from an exported file").addAttachmentOption((o) => o.setName("file").setDescription("adwarden-config.json").setRequired(true)),
    ),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();

    if (sub === "view") {
      const c = await getConfig(i.guildId);
      const ch = (id?: string) => (id ? `<#${id}>` : "—");
      const role = (id?: string) => (id ? `<@&${id}>` : "—");
      const on = (b: boolean) => (b ? "on" : "off");
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle("Server settings")
          .addFields(
            { name: "Channels", value: `Mod log ${ch(c.logChannels.mod)}\nAd log ${ch(c.logChannels.ads)}\nMessages ${ch(c.logChannels.messages)}\nMembers ${ch(c.logChannels.members)}\nReview ${ch(c.reviewChannelId)}\nAppeals ${ch(c.appealChannelId)}\nReports ${ch(c.reportChannelId)}`, inline: true },
            { name: "Modules", value: MODULES.map((m) => `${c.modules[m] ? "🟢" : "⚫"} ${m}`).join("\n"), inline: true },
            {
              name: "Ads",
              value: `Staff exempt: ${on(c.ads.exemptStaff)}\nDelete when author leaves: ${on(c.ads.deleteOnLeave)} (after ${c.ads.leaveGraceMinutes}m)\nDelete dead invites: ${on(c.ads.deleteDeadInvites)} (every ${c.ads.revalidateHours}h)\nDM on removal: ${on(c.ads.dmOnRemoval)}\nTrusted at rep ${c.ads.trustedThreshold || "off"} · role ${role(c.ads.trustedRoleId)}`,
            },
            {
              name: "Anti-raid",
              value: `Min account age: ${c.antiraid.minAccountAgeDays}d → ${c.antiraid.youngAccountAction} (role ${role(c.antiraid.quarantineRoleId)})\nJoin burst: ${c.antiraid.joinBurstCount} in ${c.antiraid.joinBurstSeconds}s · auto-lockdown ${on(c.antiraid.autoLockdown)}\nScam links: ${on(c.antiraid.scamLinks)} → ${c.antiraid.scamAction}\nMax mentions: ${c.antiraid.maxMentions || "off"} · cross-channel spam: ${on(c.antiraid.crossChannelSpam)}`,
            },
            {
              name: "Escalation",
              value: c.escalation.enabled ? c.escalation.steps.map((s) => `${s.warns} warns → ${s.action}${s.durationMs ? ` ${formatDuration(s.durationMs)}` : ""}`).join("\n") || "no steps" : "off",
            },
          ),
      );
    }

    if (sub === "channel") {
      const type = i.options.getString("type", true) as keyof typeof CHANNEL_KEYS;
      const id = i.options.getChannel("channel")?.id;
      await updateConfig(i.guildId, (c) => {
        if (type === "mod_log") c.logChannels.mod = id;
        if (type === "ad_log") c.logChannels.ads = id;
        if (type === "message_log") c.logChannels.messages = id;
        if (type === "member_log") c.logChannels.members = id;
        if (type === "review") c.reviewChannelId = id;
        if (type === "appeal") c.appealChannelId = id;
        if (type === "report") c.reportChannelId = id;
      });
      return replyOk(i, `${CHANNEL_KEYS[type]}: ${id ? `<#${id}>` : "cleared"}.`);
    }

    if (sub === "module") {
      const name = i.options.getString("name", true) as (typeof MODULES)[number];
      const enabled = i.options.getBoolean("enabled", true);
      await updateConfig(i.guildId, (c) => void (c.modules[name] = enabled));
      return replyOk(i, `Module **${name}** ${enabled ? "enabled" : "disabled"}.`);
    }

    if (sub === "ads" || sub === "antiraid") {
      const key = i.options.getString("setting", true);
      const raw = i.options.getString("value", true);
      try {
        await updateConfig(i.guildId, (c) => {
          const section = c[sub] as Record<string, unknown>;
          section[key] = coerce(section[key], raw, key);
        });
      } catch (err) {
        const msg = err instanceof Error && "issues" in err ? (err as { issues: { message: string }[] }).issues[0]?.message : "invalid value";
        return replyErr(i, `Couldn't set \`${key}\`: ${msg}`);
      }
      const c = await getConfig(i.guildId);
      return replyOk(i, `\`${key}\` is now **${JSON.stringify((c[sub] as Record<string, unknown>)[key]) ?? "none"}**.`);
    }

    if (sub === "escalation") {
      const enabled = i.options.getBoolean("enabled");
      const raw = i.options.getString("steps");
      let steps: GuildConfig["escalation"]["steps"] | undefined;
      if (raw) {
        steps = [];
        for (const part of raw.split(",")) {
          const [w, action, dur] = part.trim().split(":");
          const warns = Number(w);
          if (!Number.isInteger(warns) || warns < 1 || !["timeout", "kick", "ban"].includes(action))
            return replyErr(i, `Couldn't read "${part.trim()}". Use \`warns:action[:duration]\`, e.g. \`3:timeout:1h\`.`);
          const durationMs = dur ? parseDuration(dur) ?? undefined : undefined;
          steps.push({ warns, action: action as "timeout" | "kick" | "ban", durationMs });
        }
      }
      await updateConfig(i.guildId, (c) => {
        if (enabled !== null) c.escalation.enabled = enabled;
        if (steps) c.escalation.steps = steps;
      });
      return replyOk(i, "Escalation updated. See `/config view`.");
    }

    if (sub === "export") {
      const c = await getConfig(i.guildId);
      const adChannels = listAdChannels(i.guildId).map((a) => ({
        channelId: a.channelId,
        name: i.guild.channels.cache.get(a.channelId)?.name,
        rules: a.rules,
        ruleset: a.ruleset?.name,
      }));
      const rulesets = listRulesets(i.guildId).map((r) => ({ name: r.name, rules: r.rules }));
      const file = new AttachmentBuilder(Buffer.from(JSON.stringify({ version: 2, config: c, rulesets, adChannels }, null, 2)), { name: "adwarden-config.json" });
      return i.reply({ content: "Here are your settings. Import them on another server with `/config import`.", files: [file], flags: 64 });
    }

    if (sub === "import") {
      const file = i.options.getAttachment("file", true);
      if (file.size > 200_000) return replyErr(i, "That file is too big.");
      await i.deferReply({ flags: 64 });
      let data: {
        config?: unknown;
        rulesets?: { name?: string; rules?: unknown }[];
        adChannels?: { channelId?: string; name?: string; rules?: unknown; ruleset?: string }[];
      };
      try {
        data = await (await fetch(file.url)).json();
      } catch {
        return replyErr(i, "That isn't a valid export file.");
      }
      const parsed = GuildConfigSchema.safeParse(data.config ?? {});
      if (!parsed.success) return replyErr(i, "The settings in that file are invalid.");
      // Channel/role IDs from another server would point nowhere: keep only ones that exist here.
      const cfg = parsed.data;
      const hasCh = (id?: string) => (id && i.guild.channels.cache.has(id) ? id : undefined);
      const hasRole = (id?: string) => (id && i.guild.roles.cache.has(id) ? id : undefined);
      cfg.logChannels = { mod: hasCh(cfg.logChannels.mod), ads: hasCh(cfg.logChannels.ads), messages: hasCh(cfg.logChannels.messages), members: hasCh(cfg.logChannels.members) };
      cfg.reviewChannelId = hasCh(cfg.reviewChannelId);
      cfg.appealChannelId = hasCh(cfg.appealChannelId);
      cfg.reportChannelId = hasCh(cfg.reportChannelId);
      cfg.ads.trustedRoleId = hasRole(cfg.ads.trustedRoleId);
      cfg.antiraid.quarantineRoleId = hasRole(cfg.antiraid.quarantineRoleId);
      cfg.autoRoleIds = cfg.autoRoleIds.filter((r) => hasRole(r));
      cfg.persistRoleIds = cfg.persistRoleIds.filter((r) => hasRole(r));
      await replaceConfig(i.guildId, cfg);
      // Rulesets: update ones with the same name, create the rest
      let sets = 0;
      for (const r of (data.rulesets ?? []).slice(0, 10)) {
        const name = String(r.name ?? "").trim().slice(0, 50);
        if (!name) continue;
        const existing = findRuleset(i.guildId, name);
        if (existing) await saveRuleset(existing.id, parseRules(r.rules));
        else if (listRulesets(i.guildId).length < 10) await createRuleset(i.guildId, name, parseRules(r.rules));
        else continue;
        sets++;
      }
      let matched = 0;
      for (const a of data.adChannels ?? []) {
        const ch = (a.channelId && i.guild.channels.cache.get(a.channelId)) || i.guild.channels.cache.find((c) => c.name === a.name && c.isTextBased());
        if (!ch) continue;
        await setAdChannel(i.guildId, ch.id, parseRules(a.rules));
        const rs = a.ruleset ? findRuleset(i.guildId, a.ruleset) : undefined;
        if (rs) await linkChannel(i.guildId, ch.id, rs.id);
        matched++;
      }
      return replyOk(i, `Settings imported: ${sets} ruleset(s), ${matched}/${data.adChannels?.length ?? 0} ad channel(s) matched by ID or name.`);
    }
  },
};

export const configCommands = [config];
