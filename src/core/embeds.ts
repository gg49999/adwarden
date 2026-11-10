import { EmbedBuilder } from "discord.js";

export const COLORS = {
  brand: 0x5865f2,
  ok: 0x3ba55d,
  warn: 0xfaa61a,
  danger: 0xed4245,
  info: 0x4f8ef7,
  muted: 0x99aab5,
} as const;

export const okEmbed = (text: string, title?: string) =>
  new EmbedBuilder().setColor(COLORS.ok).setDescription(`✅ ${text}`).setTitle(title ?? null);

export const errEmbed = (text: string) =>
  new EmbedBuilder().setColor(COLORS.danger).setDescription(`❌ ${text}`);

export const infoEmbed = (title: string, text?: string) =>
  new EmbedBuilder().setColor(COLORS.brand).setTitle(title).setDescription(text ?? null);

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Escapes a code block so user content can't break out of it. */
export function codeBlock(text: string, max = 1000): string {
  return "```\n" + truncate(text.replace(/```/g, "ˋˋˋ"), max) + "\n```";
}
