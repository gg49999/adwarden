import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type Guild,
} from "discord.js";
import type { Command, ComponentHandler } from "../../core/command.js";
import { COLORS } from "../../core/embeds.js";
import { updateConfig } from "../../core/guildConfig.js";
import { replyErr } from "../../core/reply.js";
import { presetRules, summarizeRules, type PresetName } from "../ads/rules.js";
import { setAdChannel } from "../ads/store.js";
import { saveSticky } from "../sticky/service.js";

interface Session {
  guildId: string;
  userId: string;
  adChannels: string[];
  preset: PresetName;
  logChannel?: string;
  reviewChannel?: string;
  sticky: boolean;
  at: number;
}
const sessions = new Map<string, Session>();

const TEXT = [ChannelType.GuildText, ChannelType.GuildAnnouncement] as const;

function wizard(sid: string, s: Session) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle("⚙️ Adwarden setup")
    .setDescription(
      [
        "Pick your options below, then press **Finish**. You can change everything later with `/adchannel`, `/config` and `/sticky`.",
        "",
        `**1. Ad channels:** ${s.adChannels.length ? s.adChannels.map((c) => `<#${c}>`).join(" ") : "*none picked*"}`,
        `**2. Rule preset:** ${s.preset} · ${summarizeRules(presetRules(s.preset))}`,
        `**3. Log channel:** ${s.logChannel ? `<#${s.logChannel}>` : "*none picked*"}`,
        `**4. Review queue (optional):** ${s.reviewChannel ? `<#${s.reviewChannel}>` : "*off*"}`,
        `**5. Sticky "Post an Ad" button:** ${s.sticky ? "on" : "off"}`,
      ].join("\n"),
    );
  const rows = [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`setup:ads:${sid}`).setPlaceholder("1. Ad channels").addChannelTypes(...TEXT).setMinValues(0).setMaxValues(10),
    ),
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`setup:preset:${sid}`)
        .setPlaceholder("2. Rule preset")
        .addOptions(
          { label: "Strict", value: "strict", description: "Longer descriptions, 6h cooldowns, warns on violations", default: s.preset === "strict" },
          { label: "Standard", value: "standard", description: "1 invite, 30+ chars, 2h cooldowns, SFW only", default: s.preset === "standard" },
          { label: "Relaxed", value: "relaxed", description: "Short ads OK, 30 min cooldowns", default: s.preset === "relaxed" },
        ),
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`setup:log:${sid}`).setPlaceholder("3. Log channel (staff only)").addChannelTypes(...TEXT).setMinValues(0).setMaxValues(1),
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder().setCustomId(`setup:review:${sid}`).setPlaceholder("4. Review queue channel (optional)").addChannelTypes(...TEXT).setMinValues(0).setMaxValues(1),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`setup:sticky:${sid}`).setLabel(`Sticky button: ${s.sticky ? "on" : "off"}`).setStyle(s.sticky ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`setup:finish:${sid}`).setLabel("Finish").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`setup:cancel:${sid}`).setLabel("Cancel").setStyle(ButtonStyle.Danger),
    ),
  ];
  return { embeds: [embed], components: rows };
}

function permWarnings(guild: Guild, channelIds: string[]) {
  const me = guild.members.me;
  const need = [
    [PermissionFlagsBits.ViewChannel, "View Channel"],
    [PermissionFlagsBits.SendMessages, "Send Messages"],
    [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    [PermissionFlagsBits.ManageMessages, "Manage Messages"],
    [PermissionFlagsBits.ReadMessageHistory, "Read Message History"],
  ] as const;
  const out: string[] = [];
  for (const id of channelIds) {
    const ch = guild.channels.cache.get(id);
    if (!ch || !me) continue;
    const perms = ch.permissionsFor(me);
    const missing = need.filter(([p]) => !perms.has(p)).map(([, n]) => n);
    if (missing.length) out.push(`<#${id}>: missing ${missing.join(", ")}`);
  }
  return out;
}

const setup: Command = {
  module: "general",
  summary: "Guided setup: ad channels, rules preset, logs, review queue, sticky",
  data: new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set up Adwarden in about a minute")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sid = i.id;
    const s: Session = { guildId: i.guildId, userId: i.user.id, adChannels: [], preset: "standard", sticky: true, at: Date.now() };
    sessions.set(sid, s);
    for (const [k, v] of sessions) if (Date.now() - v.at > 30 * 60_000) sessions.delete(k);
    return i.reply({ ...wizard(sid, s), flags: 64 });
  },
};

export const setupHandler: ComponentHandler = {
  prefix: "setup",
  async handle(i, [action, sid]) {
    if (!i.inCachedGuild() || i.isModalSubmit()) return;
    const s = sessions.get(sid);
    if (!s || s.userId !== i.user.id) return replyErr(i, "This setup session expired. Run `/setup` again.");

    if (i.isChannelSelectMenu()) {
      if (action === "ads") s.adChannels = i.values;
      if (action === "log") s.logChannel = i.values[0];
      if (action === "review") s.reviewChannel = i.values[0];
      return i.update(wizard(sid, s));
    }
    if (i.isStringSelectMenu() && action === "preset") {
      s.preset = i.values[0] as PresetName;
      return i.update(wizard(sid, s));
    }
    if (!i.isButton()) return;
    if (action === "sticky") {
      s.sticky = !s.sticky;
      return i.update(wizard(sid, s));
    }
    if (action === "cancel") {
      sessions.delete(sid);
      return i.update({ content: "Setup cancelled.", embeds: [], components: [] });
    }
    if (action === "finish") {
      if (!s.adChannels.length) return replyErr(i, "Pick at least one ad channel.");
      await i.update({ content: "Applying…", embeds: [], components: [] });
      sessions.delete(sid);
      const rules = presetRules(s.preset);
      for (const ch of s.adChannels) await setAdChannel(i.guildId, ch, rules);
      await updateConfig(i.guildId, (c) => {
        if (s.logChannel) c.logChannels = { mod: s.logChannel, ads: s.logChannel, messages: s.logChannel, members: s.logChannel };
        if (s.reviewChannel) c.reviewChannelId = s.reviewChannel;
        if (s.logChannel && !c.reportChannelId) c.reportChannelId = s.logChannel;
      });
      const stickyFails: string[] = [];
      if (s.sticky) {
        for (const ch of s.adChannels) {
          await saveSticky(
            i.guildId,
            ch,
            { title: "Advertise your server", body: "Post your server ad below, or press **Post an Ad** for a guided form.\nAds that break the rules are removed and you'll get a DM explaining why.", postAdButton: true, showRules: true },
            4000,
          ).catch(() => stickyFails.push(ch));
        }
      }
      const warnings = permWarnings(i.guild, [...s.adChannels, ...(s.logChannel ? [s.logChannel] : []), ...(s.reviewChannel ? [s.reviewChannel] : [])]);
      const embed = new EmbedBuilder()
        .setColor(warnings.length ? COLORS.warn : COLORS.ok)
        .setTitle("✅ Setup complete")
        .setDescription(
          [
            `Watching ${s.adChannels.map((c) => `<#${c}>`).join(" ")} with the **${s.preset}** preset.`,
            s.logChannel ? `Logs go to <#${s.logChannel}>.` : "No log channel. Add one with `/config channel`.",
            s.reviewChannel ? `Review queue: <#${s.reviewChannel}>. Turn on review-all with \`/adchannel rule\` → reviewAll.` : "",
            s.sticky ? `Sticky "Post an Ad" messages are up${stickyFails.length ? ` (failed in ${stickyFails.map((c) => `<#${c}>`).join(" ")})` : ""}.` : "",
            "",
            "**Next:** `/adchannel view` to fine-tune rules · `/test-ad` to try an ad · `/help` for everything else.",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      if (warnings.length) embed.addFields({ name: "⚠️ Fix my permissions", value: warnings.join("\n").slice(0, 1000) });
      return i.editReply({ content: "", embeds: [embed] });
    }
  },
};

export const setupCommands = [setup];
