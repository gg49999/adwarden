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
} from "discord.js";
import type { Command, ComponentHandler } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { replyEmbed, replyErr, replyOk, respond } from "../../core/reply.js";
import { getAdRules } from "../ads/store.js";
import {
  getSticky,
  listStickies,
  removeSticky,
  renderSticky,
  saveSticky,
  setPaused,
  stickyContent,
  type StickyContent,
} from "./service.js";

function parseColor(raw: string): number | undefined {
  const hex = raw.trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined;
}

function stickyModal(channelId: string, opts: { button: boolean; rules: boolean; quiet: number }, existing?: StickyContent) {
  return new ModalBuilder()
    .setCustomId(`sticky:save:${channelId}:${opts.button ? 1 : 0}:${opts.rules ? 1 : 0}:${opts.quiet}`)
    .setTitle("Sticky message")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("title").setLabel("Title (optional)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200).setValue(existing?.title ?? ""),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("body")
          .setLabel("Message")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(3500)
          .setValue(existing?.body || "Post your server ad below! Read the rules first, or press **Post an Ad** for a guided form."),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("color")
          .setLabel("Color hex (optional)")
          .setPlaceholder("#5865F2")
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setMaxLength(7)
          .setValue(existing?.color != null ? `#${existing.color.toString(16).padStart(6, "0")}` : ""),
      ),
    );
}

export const stickyComponents: ComponentHandler = {
  prefix: "sticky",
  async handle(i, [action, channelId, button, rules, quiet]) {
    if (action !== "save" || !i.isModalSubmit() || !i.inCachedGuild()) return;
    if (!i.memberPermissions.has(PermissionFlagsBits.ManageMessages)) return replyErr(i, "You need Manage Messages.");
    await i.deferReply({ flags: 64 });
    const content: StickyContent = {
      title: i.fields.getTextInputValue("title").trim() || undefined,
      body: i.fields.getTextInputValue("body").trim(),
      color: parseColor(i.fields.getTextInputValue("color")),
      postAdButton: button === "1",
      showRules: rules === "1",
    };
    try {
      await saveSticky(i.guildId, channelId, content, Number(quiet) * 1000);
    } catch {
      return replyErr(i, `I couldn't post in <#${channelId}>. I need View Channel, Send Messages and Embed Links there.`);
    }
    return replyOk(i, `Sticky is live in <#${channelId}>. It reposts after ${quiet}s of quiet.`);
  },
};

const sticky: Command = {
  module: "sticky",
  summary: "Keep a message (optionally with a Post an Ad button) at the bottom of a channel",
  data: new SlashCommandBuilder()
    .setName("sticky")
    .setDescription("Messages that stay at the bottom of a channel")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .addSubcommand((s) =>
      s
        .setName("set")
        .setDescription("Create or replace a channel's sticky")
        .addChannelOption((o) => o.setName("channel").setDescription("Channel").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(true))
        .addBooleanOption((o) => o.setName("post_ad_button").setDescription("Add a 'Post an Ad' button (ad channels)"))
        .addBooleanOption((o) => o.setName("show_rules").setDescription("Show the channel's ad rules automatically"))
        .addIntegerOption((o) => o.setName("quiet_seconds").setDescription("Wait this long after the last message before reposting (default 4)").setMinValue(1).setMaxValue(300)),
    )
    .addSubcommand((s) =>
      s.setName("edit").setDescription("Edit a sticky's text").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)),
    )
    .addSubcommand((s) => s.setName("pause").setDescription("Pause a sticky").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((s) => s.setName("resume").setDescription("Resume a sticky").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((s) => s.setName("remove").setDescription("Delete a sticky").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((s) => s.setName("preview").setDescription("Preview a sticky privately").addChannelOption((o) => o.setName("channel").setDescription("Channel").setRequired(true)))
    .addSubcommand((s) => s.setName("list").setDescription("List stickies in this server")),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const sub = i.options.getSubcommand();
    if (sub === "list") {
      const list = listStickies(i.guildId);
      if (!list.length) return replyErr(i, "No stickies yet. Use `/sticky set`.");
      return replyEmbed(
        i,
        new EmbedBuilder()
          .setColor(COLORS.brand)
          .setTitle("Sticky messages")
          .setDescription(list.map((s) => `<#${s.channelId}>${s.paused ? " · ⏸ paused" : ""} · ${truncate(stickyContent(s).title ?? stickyContent(s).body, 60)}`).join("\n")),
      );
    }

    const channel = i.options.getChannel("channel", true);
    if (sub === "set") {
      const button = i.options.getBoolean("post_ad_button") ?? !!getAdRules(channel.id);
      const rules = i.options.getBoolean("show_rules") ?? !!getAdRules(channel.id);
      if (button && !getAdRules(channel.id)) return replyErr(i, `The Post an Ad button only works in ad channels. Run \`/adchannel set\` on ${channel} first.`);
      const quiet = i.options.getInteger("quiet_seconds") ?? 4;
      const existing = getSticky(channel.id);
      return i.showModal(stickyModal(channel.id, { button, rules, quiet }, existing ? stickyContent(existing) : undefined));
    }

    const s = getSticky(channel.id);
    if (!s) return replyErr(i, `${channel} has no sticky.`);
    const c = stickyContent(s);
    if (sub === "edit") return i.showModal(stickyModal(channel.id, { button: c.postAdButton, rules: c.showRules, quiet: Math.round(s.quietMs / 1000) }, c));
    if (sub === "pause") {
      await setPaused(channel.id, true);
      return replyOk(i, `Sticky in ${channel} paused.`);
    }
    if (sub === "resume") {
      await setPaused(channel.id, false);
      return replyOk(i, `Sticky in ${channel} resumed.`);
    }
    if (sub === "remove") {
      await removeSticky(channel.id);
      return replyOk(i, `Sticky in ${channel} removed.`);
    }
    if (sub === "preview") {
      const r = await renderSticky(s);
      return respond(i, { embeds: r.embeds, components: r.components as never });
    }
  },
};

export const stickyCommands = [sticky];
