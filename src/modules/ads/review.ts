import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type User,
} from "discord.js";
import { db } from "../../db.js";
import { COLORS, codeBlock, truncate } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import type { ComponentHandler } from "../../core/command.js";
import { replyErr } from "../../core/reply.js";
import { createCase } from "../moderation/service.js";
import { sendLog } from "../logging/logs.js";
import { schedule } from "../sticky/service.js";
import type { ResolvedInvite } from "./engine.js";
import { resolveInvite } from "./inviteResolver.js";
import { buildAdPost } from "./post.js";
import { getAdRules, recordAd } from "./store.js";

/** Puts an ad in the review queue. Returns false if no review channel is configured. */
export async function sendToReview(opts: {
  guild: Guild;
  channelId: string;
  author: User;
  content: string;
  invite?: ResolvedInvite;
  reason: string;
}): Promise<boolean> {
  const cfg = await getConfig(opts.guild.id);
  if (!cfg.reviewChannelId) return false;
  const channel = await opts.guild.channels.fetch(cfg.reviewChannelId).catch(() => null);
  if (!channel?.isSendable()) return false;

  const pending = await db.pendingAd.create({
    data: {
      guildId: opts.guild.id,
      channelId: opts.channelId,
      authorId: opts.author.id,
      content: opts.content,
      inviteCode: opts.invite?.code,
      targetGuildId: opts.invite?.guildId,
      targetName: opts.invite?.guildName,
      reason: opts.reason,
    },
  });

  const inv = opts.invite;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle("📥 Ad awaiting review")
    .setAuthor({ name: opts.author.username, iconURL: opts.author.displayAvatarURL() })
    .setDescription(codeBlock(opts.content, 3500))
    .addFields(
      { name: "Author", value: `${opts.author} \`${opts.author.id}\``, inline: true },
      { name: "Channel", value: `<#${opts.channelId}>`, inline: true },
      { name: "Why it's here", value: opts.reason, inline: true },
    );
  if (inv)
    embed.addFields({
      name: "Advertised server",
      value: inv.valid
        ? `**${inv.guildName ?? "Unknown"}** · ${inv.memberCount?.toLocaleString("en-US") ?? "?"} members · \`${inv.guildId ?? "?"}\`${inv.nsfwLevel === 1 || inv.nsfwLevel === 3 ? " · 🔞 NSFW" : ""}`
        : `Invalid invite \`${inv.code}\``,
    });
  if (inv?.iconUrl) embed.setThumbnail(inv.iconUrl);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`review:approve:${pending.id}`).setLabel("Approve").setStyle(ButtonStyle.Success).setEmoji("✅"),
    new ButtonBuilder().setCustomId(`review:reject:${pending.id}`).setLabel("Reject").setStyle(ButtonStyle.Danger).setEmoji("✖️"),
    new ButtonBuilder().setCustomId(`review:adban:${pending.id}`).setLabel("Reject + ad ban 7d").setStyle(ButtonStyle.Secondary).setEmoji("🚫"),
  );
  const msg = await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });
  await db.pendingAd.update({ where: { id: pending.id }, data: { reviewMessageId: msg.id } });
  return true;
}

async function finishReviewMessage(i: ButtonInteraction | ModalSubmitInteraction, status: string, color: number) {
  const msg = i.message;
  if (!msg) return;
  const embed = EmbedBuilder.from(msg.embeds[0]).setColor(color).setTitle(status);
  await msg.edit({ embeds: [embed], components: [] }).catch(() => {});
}

export const reviewHandler: ComponentHandler = {
  prefix: "review",
  async handle(i, [action, id]) {
    if (!i.inGuild() || !i.guild) return;
    if (!i.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) return replyErr(i, "You need Manage Messages to review ads.");
    const pending = await db.pendingAd.findUnique({ where: { id } });
    if (!pending || pending.status !== "pending") {
      if (i.isButton()) await i.message.edit({ components: [] }).catch(() => {});
      return replyErr(i, "This ad was already reviewed.");
    }

    if (action === "approve" && i.isButton()) {
      await i.deferUpdate();
      const channel = await i.guild.channels.fetch(pending.channelId).catch(() => null);
      if (!channel?.isSendable()) return replyErr(i, "The ad channel no longer exists or I can't post there.");
      const author = await i.client.users.fetch(pending.authorId);
      const invite = pending.inviteCode ? await resolveInvite(pending.inviteCode) : undefined;
      const posted = await channel.send(buildAdPost(author, pending.content, invite));
      const rules = getAdRules(pending.channelId);
      await recordAd({
        messageId: posted.id,
        channelId: pending.channelId,
        guildId: pending.guildId,
        authorId: pending.authorId,
        inviteCode: pending.inviteCode ?? undefined,
        targetGuildId: pending.targetGuildId ?? undefined,
        targetName: pending.targetName ?? undefined,
        expiryDays: rules?.expiryDays ?? 0,
      });
      schedule(pending.channelId);
      await db.pendingAd.update({ where: { id }, data: { status: "approved", reviewerId: i.user.id } });
      await finishReviewMessage(i, `✅ Approved by ${i.user.username}`, COLORS.ok);
      await author.send(`✅ Your ad in **${i.guild.name}** was approved: ${posted.url}`).catch(() => {});
      return;
    }

    if ((action === "reject" || action === "adban") && i.isButton()) {
      const modal = new ModalBuilder()
        .setCustomId(`review:rejectmodal:${id}:${action === "adban" ? "1" : "0"}`)
        .setTitle("Reject ad")
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId("reason")
              .setLabel("Reason (sent to the author)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setMaxLength(500),
          ),
        );
      return i.showModal(modal);
    }

    if (action === "rejectmodal" && i.isModalSubmit()) {
      const adban = i.customId.endsWith(":1");
      const reason = i.fields.getTextInputValue("reason").trim() || "Didn't meet this server's ad guidelines.";
      await i.deferUpdate();
      await db.pendingAd.update({ where: { id }, data: { status: "rejected", reviewerId: i.user.id } });
      const author = await i.client.users.fetch(pending.authorId).catch(() => null);
      if (adban && author) {
        await createCase({ guild: i.guild, type: "adban", user: author, mod: i.user, reason, durationMs: 7 * 86_400_000 });
      }
      await finishReviewMessage(i, `✖️ Rejected by ${i.user.username}${adban ? " (ad banned 7d)" : ""}`, COLORS.danger);
      await author
        ?.send({
          embeds: [
            new EmbedBuilder()
              .setColor(COLORS.danger)
              .setTitle(`Your ad in ${i.guild.name} was not approved`)
              .setDescription(`**Reason:** ${truncate(reason, 1000)}${adban ? "\n\nYou can't post ads there for 7 days." : ""}`)
              .addFields({ name: "Your ad", value: codeBlock(pending.content, 1000) }),
          ],
        })
        .catch(() => {});
      await sendLog(
        i.guild,
        "ads",
        new EmbedBuilder().setColor(COLORS.danger).setDescription(`✖️ ${i.user} rejected an ad by <@${pending.authorId}> in <#${pending.channelId}>: ${truncate(reason, 300)}`),
      );
    }
  },
};
