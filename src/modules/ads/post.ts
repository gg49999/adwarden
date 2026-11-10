import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type MessageCreateOptions,
  type User,
} from "discord.js";
import { COLORS, truncate } from "../../core/embeds.js";
import type { ResolvedInvite } from "./engine.js";

/** The standard embed the bot posts for /ad create and approved review-queue ads. */
export function buildAdPost(author: User, description: string, invite?: ResolvedInvite, tags?: string): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setAuthor({ name: `Posted by ${author.username}`, iconURL: author.displayAvatarURL() })
    .setTitle(invite?.guildName ? truncate(invite.guildName, 256) : "Server ad")
    .setDescription(truncate(description, 4000));
  if (invite?.iconUrl) embed.setThumbnail(invite.iconUrl);
  const fields = [];
  if (invite?.memberCount) fields.push({ name: "Members", value: invite.memberCount.toLocaleString("en-US"), inline: true });
  if (tags?.trim()) fields.push({ name: "Tags", value: truncate(tags.split(",").map((t) => `\`${t.trim()}\``).filter((t) => t !== "``").join(" "), 1000), inline: true });
  if (fields.length) embed.addFields(fields);
  embed.setFooter({ text: `Author ID ${author.id}` }).setTimestamp();

  const components = invite?.valid
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(`https://discord.gg/${invite.code}`).setLabel("Join server").setEmoji("🔗"),
        ),
      ]
    : [];
  return {
    content: `${author}`,
    embeds: [embed],
    components,
    allowedMentions: { users: [] },
  };
}
