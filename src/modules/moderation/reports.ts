import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, ComponentHandler } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { replyErr, replyOk } from "../../core/reply.js";
import { createCase, notifyUser, warnMember } from "./service.js";

/** /report-dm: members report someone who DM-advertised them (bots can't see DMs). */
const reportDm: Command = {
  module: "moderation",
  summary: "Report someone who sent you an unwanted ad in DMs",
  data: new SlashCommandBuilder()
    .setName("report-dm")
    .setDescription("Report someone who sent you an unwanted ad or scam in DMs")
    .setContexts(InteractionContextType.Guild)
    .addUserOption((o) => o.setName("user").setDescription("Who sent it").setRequired(true))
    .addAttachmentOption((o) => o.setName("screenshot").setDescription("Screenshot of the DM").setRequired(true))
    .addStringOption((o) => o.setName("details").setDescription("Anything else staff should know").setMaxLength(500)),
  async execute(i) {
    if (!i.inCachedGuild()) return;
    const cfg = await getConfig(i.guildId);
    const channelId = cfg.reportChannelId ?? cfg.logChannels.mod;
    if (!channelId) return replyErr(i, "Reports aren't set up here yet. Ask staff to run `/config channel`.");
    const channel = await i.guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isSendable()) return replyErr(i, "I can't reach the report channel.");
    const user = i.options.getUser("user", true);
    if (user.id === i.user.id) return replyErr(i, "You can't report yourself.");
    const shot = i.options.getAttachment("screenshot", true);
    if (!shot.contentType?.startsWith("image/")) return replyErr(i, "The screenshot must be an image.");

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.warn)
          .setTitle("📩 DM advertising report")
          .addFields(
            { name: "Reported", value: `${user} \`${user.id}\``, inline: true },
            { name: "Reporter", value: `${i.user}`, inline: true },
            { name: "Details", value: truncate(i.options.getString("details") ?? "*None*", 1000) },
          )
          .setImage(shot.url)
          .setTimestamp(),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`report:warn:${user.id}`).setLabel("Warn").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`report:ban:${user.id}`).setLabel("Ban").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`report:dismiss:${user.id}`).setLabel("Dismiss").setStyle(ButtonStyle.Secondary),
        ),
      ],
      allowedMentions: { parse: [] },
    });
    return replyOk(i, "Thanks, your report was sent to the staff.");
  },
};

export const reportHandler: ComponentHandler = {
  prefix: "report",
  async handle(i, [action, userId]) {
    if (!i.isButton() || !i.inCachedGuild()) return;
    const need = action === "ban" ? PermissionFlagsBits.BanMembers : PermissionFlagsBits.ModerateMembers;
    if (!i.memberPermissions.has(need)) return replyErr(i, "You don't have permission to do that.");
    const reason = "DM advertising (member report)";
    let result = "Dismissed";
    if (action === "warn") {
      const member = await i.guild.members.fetch(userId).catch(() => null);
      if (!member) return replyErr(i, "They're no longer in the server.");
      const w = await warnMember(i.guild, member, i.user, reason);
      result = `Warned (case #${w.case.number})`;
    } else if (action === "ban") {
      const user = await i.client.users.fetch(userId);
      await notifyUser(i.guild, user, "ban", reason);
      await i.guild.members.ban(userId, { reason });
      const c = await createCase({ guild: i.guild, type: "ban", user, mod: i.user, reason });
      result = `Banned (case #${c.number})`;
    }
    const embed = EmbedBuilder.from(i.message.embeds[0]).setColor(action === "dismiss" ? COLORS.muted : COLORS.ok).setFooter({ text: `${result} by ${i.user.username}` });
    return i.update({ embeds: [embed], components: [] });
  },
};

export const reportCommands = [reportDm];
