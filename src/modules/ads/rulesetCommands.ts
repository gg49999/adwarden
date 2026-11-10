import { ChannelType, EmbedBuilder, InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { Command } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { replyEmbed, replyErr, replyOk } from "../../core/reply.js";
import { PRESETS, presetRules, RULE_HELP, setRule, summarizeRules, type PresetName, type RuleKey } from "./rules.js";
import {
  channelsUsingRuleset,
  createRuleset,
  deleteRuleset,
  findRuleset,
  getAdRules,
  linkChannel,
  listRulesets,
  renameRuleset,
  saveRuleset,
  setAdChannel,
} from "./store.js";

const AD_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

/** Autocomplete for rule names and ruleset names, shared with /adchannel. */
export function ruleKeyAutocomplete(query: string) {
  const q = query.toLowerCase();
  return (Object.keys(RULE_HELP) as RuleKey[])
    .filter((k) => k.toLowerCase().includes(q) || RULE_HELP[k].toLowerCase().includes(q))
    .slice(0, 25)
    .map((k) => ({ name: `${k}: ${RULE_HELP[k]}`.slice(0, 100), value: k }));
}

const ruleset: Command = {
  module: "ads",
  summary: "Named sets of ad restrictions shared between channels",
  data: new SlashCommandBuilder()
    .setName("ruleset")
    .setDescription("Reusable sets of ad rules")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((s) =>
      s
        .setName("create")
        .setDescription("Create a ruleset")
        .addStringOption((o) => o.setName("name").setDescription("Name").setRequired(true).setMaxLength(50))
        .addStringOption((o) => o.setName("preset").setDescription("Start from a preset").addChoices(...Object.keys(PRESETS).map((p) => ({ name: p, value: p }))))
        .addChannelOption((o) => o.setName("copy_from").setDescription("…or copy an ad channel's current rules").addChannelTypes(...AD_TYPES)),
    )
    .addSubcommand((s) =>
      s
        .setName("rule")
        .setDescription("Change one rule in a ruleset")
        .addStringOption((o) => o.setName("name").setDescription("Ruleset").setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName("rule").setDescription("Rule").setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName("value").setDescription("New value (on/off, a number, or a comma list)").setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("apply")
        .setDescription("Make a channel follow this ruleset")
        .addStringOption((o) => o.setName("name").setDescription("Ruleset").setRequired(true).setAutocomplete(true))
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(...AD_TYPES).setRequired(true)),
    )
    .addSubcommand((s) =>
      s.setName("unlink").setDescription("Give a channel its own rules again (keeps a copy)").addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(...AD_TYPES).setRequired(true)),
    )
    .addSubcommand((s) =>
      s
        .setName("rename")
        .setDescription("Rename a ruleset")
        .addStringOption((o) => o.setName("name").setDescription("Ruleset").setRequired(true).setAutocomplete(true))
        .addStringOption((o) => o.setName("new_name").setDescription("New name").setRequired(true).setMaxLength(50)),
    )
    .addSubcommand((s) => s.setName("view").setDescription("Show a ruleset").addStringOption((o) => o.setName("name").setDescription("Ruleset").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List rulesets"))
    .addSubcommand((s) =>
      s.setName("delete").setDescription("Delete a ruleset (channels keep a copy of its rules)").addStringOption((o) => o.setName("name").setDescription("Ruleset").setRequired(true).setAutocomplete(true)),
    ),
  async autocomplete(i) {
    if (!i.inGuild()) return;
    const focused = i.options.getFocused(true);
    if (focused.name === "rule") return i.respond(ruleKeyAutocomplete(focused.value));
    const q = focused.value.toLowerCase();
    return i.respond(listRulesets(i.guildId).filter((r) => r.name.toLowerCase().includes(q)).slice(0, 25).map((r) => ({ name: r.name, value: r.id })));
  },
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();

    if (sub === "create") {
      const name = i.options.getString("name", true).trim();
      if (findRuleset(i.guildId, name)) return replyErr(i, `A ruleset called **${name}** already exists.`);
      if (listRulesets(i.guildId).length >= 10) return replyErr(i, "A server can have up to 10 rulesets.");
      const from = i.options.getChannel("copy_from");
      const base = from ? getAdRules(from.id) : undefined;
      if (from && !base) return replyErr(i, `${from} isn't an ad channel.`);
      const rules = base ?? presetRules((i.options.getString("preset") as PresetName | null) ?? "standard");
      const rs = await createRuleset(i.guildId, name, rules);
      return replyOk(i, `Created ruleset **${rs.name}**. Link channels with \`/ruleset apply\`, or edit it in \`/settings\` → Ad rules.`);
    }
    if (sub === "list") {
      const sets = listRulesets(i.guildId);
      if (!sets.length) return replyErr(i, "No rulesets yet. Use `/ruleset create`.");
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle("Rulesets")
          .setDescription(sets.map((s) => {
            const used = channelsUsingRuleset(s.id);
            return `📚 **${s.name}** · ${used.length ? used.map((c) => `<#${c}>`).join(" ") : "not used"}\n${truncate(summarizeRules(s.rules), 200)}`;
          }).join("\n\n")),
      );
    }
    if (sub === "unlink") {
      const ch = i.options.getChannel("channel", true);
      if (!getAdRules(ch.id)) return replyErr(i, `${ch} isn't an ad channel.`);
      const copy = getAdRules(ch.id)!;
      await linkChannel(i.guildId, ch.id, null);
      await setAdChannel(i.guildId, ch.id, copy);
      return replyOk(i, `${ch} now has its own rules (copied from its ruleset).`);
    }

    const rs = findRuleset(i.guildId, i.options.getString("name", true));
    if (!rs) return replyErr(i, "Ruleset not found. Pick one from the list.");

    if (sub === "rule") {
      const key = i.options.getString("rule", true) as RuleKey;
      if (!(key in RULE_HELP)) return replyErr(i, "Unknown rule. Pick one from the list.");
      const next = setRule(rs.rules, key, i.options.getString("value", true));
      if (typeof next === "string") return replyErr(i, next);
      await saveRuleset(rs.id, next);
      const n = channelsUsingRuleset(rs.id).length;
      return replyOk(i, `\`${key}\` is now **${JSON.stringify(next[key])}** in **${rs.name}** (affects ${n} channel(s)).`);
    }
    if (sub === "apply") {
      const ch = i.options.getChannel("channel", true);
      await linkChannel(i.guildId, ch.id, rs.id);
      return replyOk(i, `${ch} now follows **${rs.name}**.\n${summarizeRules(rs.rules)}`);
    }
    if (sub === "rename") {
      const name = i.options.getString("new_name", true).trim();
      if (findRuleset(i.guildId, name)) return replyErr(i, `A ruleset called **${name}** already exists.`);
      await renameRuleset(rs.id, name);
      return replyOk(i, `Renamed to **${name}**.`);
    }
    if (sub === "view") {
      const lines = (Object.keys(RULE_HELP) as RuleKey[]).map((k) => `\`${k}\` **${JSON.stringify(rs.rules[k])}**`);
      const used = channelsUsingRuleset(rs.id);
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle(`📚 ${rs.name}`)
          .setDescription(`Used by: ${used.length ? used.map((c) => `<#${c}>`).join(" ") : "no channels"}\n\n${truncate(lines.join("\n"), 3800)}`),
      );
    }
    if (sub === "delete") {
      const n = await deleteRuleset(rs.id);
      return replyOk(i, `Deleted **${rs.name}**.${n ? ` ${n} channel(s) kept a copy of its rules.` : ""}`);
    }
  },
};

export const rulesetCommands = [ruleset];
