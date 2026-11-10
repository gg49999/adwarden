/**
 * Gathers everything the pure rule engine needs (invites, cooldowns, blocklist, member age)
 * for a piece of ad content, then runs it.
 */
import type { Guild, GuildMember } from "discord.js";
import { db } from "../../db.js";
import { isAdBanned } from "../moderation/service.js";
import { evaluateAd, type ResolvedInvite, type Violation } from "./engine.js";
import { scanInvites } from "./inviteResolver.js";
import type { ChannelRules } from "./rules.js";

export interface CheckInput {
  guild: Guild;
  channelId: string;
  authorId: string;
  member: GuildMember | null;
  content: string;
  rules: ChannelRules;
  hasEveryoneMention?: boolean;
  roleMentionCount?: number;
  attachmentCount?: number;
  /** Ignore this message when looking up cooldowns/duplicates (edit re-checks). */
  excludeMessageId?: string;
  /** Skip cooldown checks (edit re-checks, /test-ad dry runs can choose). */
  skipCooldowns?: boolean;
}

export interface CheckResult {
  violations: Violation[];
  invites: ResolvedInvite[];
  primary?: ResolvedInvite;
}

const minutesSince = (d: Date | undefined | null) => (d ? (Date.now() - d.getTime()) / 60_000 : null);

export async function checkAd(input: CheckInput): Promise<CheckResult> {
  const { guild, channelId, authorId, rules } = input;
  const { invites, resolvedShortenerUrls } = await scanInvites(input.content);
  const primary = invites.find((i) => i.valid && i.guildId) ?? invites[0];
  const targetIds = invites.map((i) => i.guildId).filter((x): x is string => !!x);
  const notThis = input.excludeMessageId ? { not: input.excludeMessageId } : undefined;

  const [blocked, userAd, serverAd, otherLive, adBanned] = await Promise.all([
    targetIds.length
      ? db.blockedServer.findMany({ where: { guildId: guild.id, targetGuildId: { in: targetIds } } })
      : Promise.resolve([]),
    input.skipCooldowns || !rules.userCooldownMinutes
      ? null
      : db.ad.findFirst({ where: { guildId: guild.id, channelId, authorId, messageId: notThis }, orderBy: { createdAt: "desc" } }),
    input.skipCooldowns || !rules.serverCooldownMinutes || !primary?.guildId
      ? null
      : db.ad.findFirst({ where: { guildId: guild.id, channelId, targetGuildId: primary.guildId, messageId: notThis }, orderBy: { createdAt: "desc" } }),
    !rules.blockCrossChannelDuplicates || !primary?.guildId
      ? null
      : db.ad.findFirst({ where: { guildId: guild.id, targetGuildId: primary.guildId, status: "live", channelId: { not: channelId }, messageId: notThis } }),
    isAdBanned(guild.id, authorId),
  ]);

  const violations = evaluateAd({
    content: input.content,
    rules,
    invites,
    resolvedShortenerUrls,
    hasEveryoneMention: input.hasEveryoneMention,
    roleMentionCount: input.roleMentionCount,
    attachmentCount: input.attachmentCount,
    memberJoinedMinutesAgo: input.member?.joinedAt ? minutesSince(input.member.joinedAt) : null,
    minutesSinceUserAd: minutesSince(userAd?.createdAt),
    minutesSinceServerAd: minutesSince(serverAd?.createdAt),
    liveInOtherChannel: !!otherLive,
    blockedServerIds: new Set(blocked.map((b) => b.targetGuildId)),
    userAdBanned: adBanned,
  });
  return { violations, invites, primary };
}
