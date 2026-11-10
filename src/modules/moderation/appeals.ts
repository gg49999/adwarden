import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { client } from "../../client.js";
import type { ComponentHandler } from "../../core/command.js";
import { COLORS, truncate } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { replyErr, replyOk } from "../../core/reply.js";
import { createCase } from "./service.js";

const lastAppeal = new Map<string, number>();

/** Ban appeals: a button in the ban DM opens a form; staff accept or deny in the appeal channel. */
export const appealHandler: ComponentHandler = {
  prefix: "appeal",
  async handle(i, [action, guildId, userId]) {
    if (action === "open" && i.isButton()) {
      const last = lastAppeal.get(`${guildId}:${i.user.id}`);
      if (last && Date.now() - last < 7 * 86_400_000) return replyErr(i, "You already appealed this week.");
      return i.showModal(
        new ModalBuilder()
          .setCustomId(`appeal:submit:${guildId}`)
          .setTitle("Ban appeal")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder().setCustomId("why").setLabel("Why should you be unbanned?").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1500),
            ),
          ),
      );
    }

    if (action === "submit" && i.isModalSubmit()) {
      const guild = client.guilds.cache.get(guildId);
      const cfg = await getConfig(guildId);
      if (!guild || !cfg.appealChannelId) return replyErr(i, "Appeals aren't open for that server right now.");
      const ban = await guild.bans.fetch(i.user.id).catch(() => null);
      if (!ban) return replyErr(i, "You aren't banned from that server.");
      const channel = await guild.channels.fetch(cfg.appealChannelId).catch(() => null);
      if (!channel?.isSendable()) return replyErr(i, "Appeals aren't open for that server right now.");
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.info)
            .setTitle("📨 Ban appeal")
            .setAuthor({ name: i.user.username, iconURL: i.user.displayAvatarURL() })
            .addFields(
              { name: "User", value: `${i.user} \`${i.user.id}\`` },
              { name: "Ban reason", value: ban.reason ?? "*None*" },
              { name: "Appeal", value: truncate(i.fields.getTextInputValue("why"), 1024) },
            ),
        ],
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`appeal:accept:${guildId}:${i.user.id}`).setLabel("Accept & unban").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`appeal:deny:${guildId}:${i.user.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger),
          ),
        ],
        allowedMentions: { parse: [] },
      });
      lastAppeal.set(`${guildId}:${i.user.id}`, Date.now());
      return replyOk(i, "Your appeal was sent to the staff. You'll get a DM with their decision.");
    }

    if ((action === "accept" || action === "deny") && i.isButton()) {
      if (!i.inCachedGuild() || !i.memberPermissions.has(PermissionFlagsBits.BanMembers)) return replyErr(i, "You need Ban Members to decide appeals.");
      const user = await client.users.fetch(userId);
      if (action === "accept") {
        await i.guild.members.unban(userId, `Appeal accepted by ${i.user.username}`).catch(() => {});
        await createCase({ guild: i.guild, type: "unban", user, mod: i.user, reason: "Appeal accepted" });
        await user.send(`✅ Your ban appeal for **${i.guild.name}** was accepted. You can rejoin now.`).catch(() => {});
      } else {
        await user.send(`Your ban appeal for **${i.guild.name}** was denied.`).catch(() => {});
      }
      const embed = EmbedBuilder.from(i.message.embeds[0])
        .setColor(action === "accept" ? COLORS.ok : COLORS.danger)
        .setFooter({ text: `${action === "accept" ? "Accepted" : "Denied"} by ${i.user.username}` });
      return i.update({ embeds: [embed], components: [] });
    }
  },
};
