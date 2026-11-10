import { EmbedBuilder, type GuildMember, type Message, type PartialGuildMember, type PartialMessage } from "discord.js";
import { COLORS, codeBlock } from "../../core/embeds.js";
import { isStickyMessage } from "../sticky/service.js";
import { sendLog, wasBotDeleted } from "./logs.js";

export async function logMessageDelete(message: Message | PartialMessage) {
  if (!message.inGuild() || message.author?.bot || isStickyMessage(message.id) || wasBotDeleted(message.id)) return;
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setAuthor({ name: "Message deleted", iconURL: message.author?.displayAvatarURL() })
    .setDescription(`${message.author ?? "Unknown user"} in ${message.channel}`)
    .addFields({ name: "Content", value: message.partial ? "*Not cached (sent before I started)*" : codeBlock(message.content || "(no text)", 1000) });
  if (message.attachments?.size) embed.addFields({ name: "Attachments", value: message.attachments.map((a) => a.name).join(", ").slice(0, 1000) });
  await sendLog(message.guild, "messages", embed);
}

export async function logMessageEdit(before: Message | PartialMessage, after: Message) {
  if (!after.inGuild() || after.author.bot || before.content === after.content || before.partial) return;
  await sendLog(
    after.guild,
    "messages",
    new EmbedBuilder()
      .setColor(COLORS.warn)
      .setAuthor({ name: "Message edited", iconURL: after.author.displayAvatarURL() })
      .setDescription(`${after.author} in ${after.channel} · [jump](${after.url})`)
      .addFields({ name: "Before", value: codeBlock(before.content || "(empty)", 500) }, { name: "After", value: codeBlock(after.content || "(empty)", 500) }),
  );
}

export async function logMemberJoin(member: GuildMember) {
  const ageDays = Math.floor((Date.now() - member.user.createdTimestamp) / 86_400_000);
  await sendLog(
    member.guild,
    "members",
    new EmbedBuilder()
      .setColor(COLORS.ok)
      .setAuthor({ name: "Member joined", iconURL: member.user.displayAvatarURL() })
      .setDescription(`${member} \`${member.id}\`\nAccount created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>${ageDays < 7 ? " · ⚠️ new account" : ""}`)
      .setFooter({ text: `Members: ${member.guild.memberCount}` }),
  );
}

export async function logMemberLeave(member: GuildMember | PartialGuildMember) {
  const roles = member.roles?.cache.filter((r) => r.id !== member.guild.id).map((r) => `${r}`).join(" ") || "—";
  await sendLog(
    member.guild,
    "members",
    new EmbedBuilder()
      .setColor(COLORS.muted)
      .setAuthor({ name: "Member left", iconURL: member.user?.displayAvatarURL() })
      .setDescription(`${member.user ?? member.id} \`${member.id}\`${member.joinedTimestamp ? `\nJoined <t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : ""}`)
      .addFields({ name: "Roles", value: roles.slice(0, 1000) })
      .setFooter({ text: `Members: ${member.guild.memberCount}` }),
  );
}
