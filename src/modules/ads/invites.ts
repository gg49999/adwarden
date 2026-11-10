/**
 * Pure text helpers: find invites and links in a message, even when people try to hide them.
 */

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;

/** Strips zero-width characters and un-spaces common invite obfuscations like "discord . gg / abc". */
export function normalize(text: string): string {
  return text
    .replace(ZERO_WIDTH, "")
    .replace(/discord\s*(?:\.|\(dot\)|\[dot\]|dot)\s*gg\s*\/\s*/gi, "discord.gg/")
    .replace(/discord(?:app)?\s*\.\s*com\s*\/\s*invite\s*\/\s*/gi, "discord.com/invite/");
}

const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg)\/([a-z0-9-]{2,32})/gi;

/** Invite codes (deduplicated, original case preserved) found in the text. */
export function extractInviteCodes(text: string): string[] {
  const codes = new Set<string>();
  for (const m of normalize(text).matchAll(INVITE_RE)) codes.add(m[1]);
  return [...codes];
}

const URL_RE = /https?:\/\/[^\s<>()[\]"']+/gi;
const MASKED_RE = /\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?\s*\)/gi;

export interface FoundLink {
  url: string;
  host: string;
  masked: boolean;
}

export function extractLinks(text: string): FoundLink[] {
  const t = normalize(text);
  const out: FoundLink[] = [];
  const seen = new Set<string>();
  for (const m of t.matchAll(MASKED_RE)) {
    const url = m[2];
    seen.add(url);
    out.push({ url, host: hostOf(url), masked: true });
  }
  for (const m of t.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,!?;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, host: hostOf(url), masked: false });
  }
  return out;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function isInviteHost(host: string): boolean {
  return host === "discord.gg" || host === "discord.com" || host === "discordapp.com";
}

/** Link shorteners and invite redirectors that should be resolved before judging. */
export const SHORTENERS = new Set([
  "bit.ly", "tinyurl.com", "t.co", "cutt.ly", "is.gd", "rb.gy", "shorturl.at", "rebrand.ly",
  "dsc.gg", "discord.link", "invite.gg", "dis.gd", "discord.me", "discord.io", "top.gg",
  "goo.gl", "ow.ly", "buff.ly", "tiny.cc", "s.id",
]);

export function hostMatches(host: string, domains: string[]): boolean {
  return domains.some((d) => {
    const dd = d.toLowerCase().replace(/^www\./, "");
    return host === dd || host.endsWith("." + dd);
  });
}

/** Text with links and invites removed, for measuring how much description an ad has. */
export function descriptionText(text: string): string {
  return normalize(text)
    .replace(MASKED_RE, "$1")
    .replace(URL_RE, "")
    .replace(INVITE_RE, "")
    .replace(/<a?:\w+:\d+>/g, "") // custom emojis
    .replace(/<[@#][!&]?\d+>/g, "") // mentions
    .replace(/[*_~`|>#-]/g, "") // markdown
    .replace(/\s+/g, " ")
    .trim();
}

const EMOJI_RE = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;
export const countEmojis = (text: string) => (text.match(EMOJI_RE) ?? []).length;

export function capsPercent(text: string): number {
  const letters = descriptionText(text).replace(/[^\p{L}]/gu, "");
  if (letters.length < 20) return 0;
  const upper = letters.replace(/[^\p{Lu}]/gu, "").length;
  return Math.round((upper / letters.length) * 100);
}

/** Lowercased fingerprint for duplicate/spam detection. */
export function fingerprint(text: string): string {
  return normalize(text).toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
}
