import {
  MessageFlags,
  type EmbedBuilder,
  type RepliableInteraction,
  type InteractionReplyOptions,
} from "discord.js";
import { errEmbed, okEmbed } from "./embeds.js";

/**
 * Replies (ephemeral by default), or edits/follows up if the interaction was
 * already deferred or answered.
 */
export async function respond(i: RepliableInteraction, opts: Omit<InteractionReplyOptions, "flags">, ephemeral = true) {
  if (i.deferred && !i.replied) return i.editReply(opts as never);
  const payload: InteractionReplyOptions = ephemeral ? { ...opts, flags: MessageFlags.Ephemeral } : opts;
  if (i.replied) return i.followUp(payload);
  return i.reply(payload);
}

export const replyOk = (i: RepliableInteraction, text: string) => respond(i, { embeds: [okEmbed(text)] });
export const replyErr = (i: RepliableInteraction, text: string) => respond(i, { embeds: [errEmbed(text)] });
export const replyEmbed = (i: RepliableInteraction, embed: EmbedBuilder, isPublic = false) =>
  respond(i, { embeds: [embed] }, !isPublic);

/** Thrown inside handlers to show a friendly error instead of a stack trace. */
export class UserError extends Error {}
