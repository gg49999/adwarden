import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  RESTJSONErrorCodes,
  type Message,
  type MessageCreateOptions,
  type TextBasedChannel,
} from "discord.js";
import type { Sticky } from "@prisma/client";
import { client } from "../../client.js";
import { db, parseJson } from "../../db.js";
import { COLORS } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { log } from "../../logger.js";
import { parseRules, summarizeRules } from "../ads/rules.js";

export interface StickyContent {
  title?: string;
  body: string;
  color?: number;
  postAdButton: boolean;
  showRules: boolean;
}

const stickies = new Map<string, Sticky>();
const timers = new Map<string, NodeJS.Timeout>();
const locks = new Map<string, Promise<void>>();
/** Message IDs the bot just posted as stickies (so the gateway echo is ignored). */
const ownPosts = new Set<string>();

export async function loadStickies() {
  stickies.clear();
  for (const s of await db.sticky.findMany()) stickies.set(s.channelId, s);
  log.info(`Loaded ${stickies.size} sticky message(s)`);
}

export const getSticky = (channelId: string) => stickies.get(channelId);
export const stickyContent = (s: Sticky) => parseJson<StickyContent>(s.content, { body: "", postAdButton: false, showRules: false });
export const listStickies = (guildId: string) => [...stickies.values()].filter((s) => s.guildId === guildId);
export const isStickyMessage = (messageId: string) => ownPosts.has(messageId) || [...stickies.values()].some((s) => s.messageId === messageId);

export async function saveSticky(guildId: string, channelId: string, content: StickyContent, quietMs: number) {
  const row = await db.sticky.upsert({
    where: { channelId },
    create: { channelId, guildId, content: JSON.stringify(content), quietMs },
    update: { content: JSON.stringify(content), quietMs, paused: false },
  });
  stickies.set(channelId, row);
  await withLock(channelId, () => repost(channelId, true));
  return stickies.get(channelId)!;
}

export async function setPaused(channelId: string, paused: boolean) {
  const row = await db.sticky.update({ where: { channelId }, data: { paused } });
  stickies.set(channelId, row);
  if (!paused) await withLock(channelId, () => repost(channelId, true));
}

export async function removeSticky(channelId: string) {
  const s = stickies.get(channelId);
  stickies.delete(channelId);
  clearTimeout(timers.get(channelId));
  await db.sticky.delete({ where: { channelId } }).catch(() => {});
  if (s?.messageId) {
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch?.isTextBased()) await ch.messages.delete(s.messageId).catch(() => {});
  }
}

export async function renderSticky(s: Sticky): Promise<MessageCreateOptions> {
  const c = stickyContent(s);
  const embed = new EmbedBuilder().setColor(c.color ?? COLORS.brand).setDescription(c.body || "​");
  if (c.title) embed.setTitle(`📌 ${c.title}`);
  if (c.showRules) {
    const ch = await db.adChannel.findUnique({ where: { channelId: s.channelId } });
    if (ch) embed.addFields({ name: "Rules for this channel", value: summarizeRules(parseRules(parseJson(ch.rules, {}))) || "No extra rules" });
  }
  embed.setFooter({ text: "This message stays at the bottom of the channel" });
  const components = c.postAdButton
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`ad:create:${s.channelId}`).setLabel("Post an Ad").setEmoji("📢").setStyle(ButtonStyle.Primary),
        ),
      ]
    : [];
  return { embeds: [embed], components, allowedMentions: { parse: [] } };
}

/** Called for every message that survived moderation in a channel. */
export function notifyMessage(message: Message) {
  if (message.author.id === client.user?.id && ownPosts.has(message.id)) return;
  if (!message.inGuild()) return;
  const s = stickies.get(message.channelId);
  if (!s || s.paused) return;
  void getConfig(message.guildId).then((cfg) => {
    if (!cfg.modules.sticky) return;
    schedule(message.channelId, s.quietMs);
  });
}

/** Schedules a debounced repost (also used after the bot posts an approved ad). */
export function schedule(channelId: string, quietMs?: number) {
  const s = stickies.get(channelId);
  if (!s || s.paused) return;
  clearTimeout(timers.get(channelId));
  timers.set(
    channelId,
    setTimeout(() => {
      timers.delete(channelId);
      void withLock(channelId, () => repost(channelId));
    }, quietMs ?? s.quietMs),
  );
}

function withLock(key: string, fn: () => Promise<void>): Promise<void> {
  const next = (locks.get(key) ?? Promise.resolve())
    .then(fn)
    .catch((err) => log.warn(`Sticky repost failed in ${key}`, err));
  locks.set(key, next);
  void next.finally(() => {
    if (locks.get(key) === next) locks.delete(key);
  });
  return next;
}

async function repost(channelId: string, force = false) {
  const s = stickies.get(channelId);
  if (!s || s.paused) return;
  const channel = (await client.channels.fetch(channelId).catch(() => null)) as TextBasedChannel | null;
  if (!channel || !channel.isSendable()) return;
  if (!force && s.messageId && channel.lastMessageId === s.messageId) return; // already at the bottom

  const fresh = await channel.send(await renderSticky(s)); // send first...
  ownPosts.add(fresh.id);
  setTimeout(() => ownPosts.delete(fresh.id), 60_000);
  const oldId = s.messageId;
  const updated = await db.sticky.update({ where: { channelId }, data: { messageId: fresh.id } });
  stickies.set(channelId, updated);
  if (oldId && oldId !== fresh.id) {
    await channel.messages.delete(oldId).catch((err) => {
      if (!(err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownMessage)) throw err;
    }); // ...then delete the old one
  }
}

/**
 * Startup + periodic safety net: makes sure each sticky is the last message and
 * removes stray old copies (e.g. after a crash between send and delete).
 */
export async function reconcileStickies(deep = false) {
  for (const s of stickies.values()) {
    if (s.paused) continue;
    try {
      const channel = await client.channels.fetch(s.channelId).catch(() => null);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) continue;
      if (deep) {
        const recent = await channel.messages.fetch({ limit: 25 });
        const strays = recent.filter(
          (m) => m.author.id === client.user?.id && m.id !== s.messageId && m.embeds[0]?.footer?.text === "This message stays at the bottom of the channel",
        );
        for (const m of strays.values()) await m.delete().catch(() => {});
      }
      if (channel.lastMessageId !== s.messageId) await withLock(s.channelId, () => repost(s.channelId));
    } catch (err) {
      log.warn(`Sticky reconcile failed for ${s.channelId}`, err);
    }
  }
}
