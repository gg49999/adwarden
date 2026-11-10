/**
 * The ad rule engine. Pure: all Discord/DB lookups happen before this is called,
 * so it is fully unit-testable (see tests/engine.test.ts).
 */
import type { ChannelRules } from "./rules.js";
import {
  capsPercent,
  countEmojis,
  descriptionText,
  extractLinks,
  hostMatches,
  isInviteHost,
  SHORTENERS,
} from "./invites.js";
import { compiledFor, findWord } from "../wordfilter/filter.js";

export interface ResolvedInvite {
  code: string;
  valid: boolean;
  guildId?: string;
  guildName?: string;
  memberCount?: number;
  /** Discord NSFW level: 0 default, 1 explicit, 2 safe, 3 age restricted */
  nsfwLevel?: number;
  iconUrl?: string | null;
  /** Resolved from a shortener rather than written directly */
  viaShortener?: boolean;
}

export interface AdContext {
  content: string;
  rules: ChannelRules;
  invites: ResolvedInvite[];
  /** Shortener URLs that were followed and led to a Discord invite (treated as invites) */
  resolvedShortenerUrls?: string[];
  hasEveryoneMention?: boolean;
  roleMentionCount?: number;
  memberJoinedMinutesAgo?: number | null;
  /** Minutes since the user's last live ad in this channel, null if none */
  minutesSinceUserAd?: number | null;
  /** Minutes since the advertised server's last ad in this channel, null if none */
  minutesSinceServerAd?: number | null;
  /** The advertised server already has a live ad in another channel */
  liveInOtherChannel?: boolean;
  blockedServerIds?: Set<string>;
  userAdBanned?: boolean;
  attachmentCount?: number;
}

export type RuleId =
  | "ad_banned"
  | "no_invite"
  | "too_many_invites"
  | "invalid_invite"
  | "blocked_server"
  | "nsfw_server"
  | "too_few_members"
  | "link_only"
  | "short_description"
  | "long_description"
  | "too_long"
  | "attachments"
  | "blocked_word"
  | "other_links"
  | "too_many_lines"
  | "too_many_emojis"
  | "mass_mention"
  | "role_mention"
  | "caps"
  | "missing_keyword"
  | "new_member"
  | "user_cooldown"
  | "server_cooldown"
  | "duplicate_elsewhere";

export interface Violation {
  rule: RuleId;
  message: string;
}

export function evaluateAd(ctx: AdContext): Violation[] {
  const { rules: r, content } = ctx;
  const v: Violation[] = [];
  const add = (rule: RuleId, message: string) => v.push({ rule, message });

  if (ctx.userAdBanned) {
    add("ad_banned", "You are currently banned from posting ads here.");
    return v;
  }

  const invites = ctx.invites;
  const validInvites = invites.filter((i) => i.valid);

  // Invites
  if (r.requireInvite && invites.length === 0) add("no_invite", "Your ad needs a Discord invite link.");
  if (r.maxInvites > 0 && invites.length > r.maxInvites)
    add("too_many_invites", `Only ${r.maxInvites} invite${r.maxInvites === 1 ? "" : "s"} allowed per ad (found ${invites.length}).`);
  for (const inv of invites) {
    if (!inv.valid) add("invalid_invite", `The invite \`${inv.code}\` is invalid or expired.`);
  }
  for (const inv of validInvites) {
    const name = inv.guildName ? `**${inv.guildName}**` : "That server";
    if (inv.guildId && ctx.blockedServerIds?.has(inv.guildId)) add("blocked_server", `${name} is not allowed to be advertised here.`);
    if (r.blockNsfwServers && (inv.nsfwLevel === 1 || inv.nsfwLevel === 3))
      add("nsfw_server", `${name} is marked NSFW/age-restricted, which isn't allowed in this channel.`);
    if (r.minServerMembers > 0 && (inv.memberCount ?? 0) < r.minServerMembers)
      add("too_few_members", `${name} needs at least ${r.minServerMembers} members to be advertised here (has ${inv.memberCount ?? 0}).`);
  }

  // Description
  const desc = descriptionText(content);
  if (r.minDescriptionChars > 0 && desc.length < r.minDescriptionChars) {
    if (desc.length === 0) add("link_only", "Your ad is just a link. Add a description of your server.");
    else add("short_description", `Your description is too short (${desc.length}/${r.minDescriptionChars} characters).`);
  }

  if (r.maxDescriptionChars > 0 && desc.length > r.maxDescriptionChars)
    add("long_description", `Your description is too long (${desc.length}/${r.maxDescriptionChars} characters).`);
  if (r.maxChars > 0 && content.length > r.maxChars) add("too_long", `Your ad is too long (${content.length}/${r.maxChars} characters).`);
  if (!r.allowAttachments && (ctx.attachmentCount ?? 0) > 0) add("attachments", "Images and files aren't allowed in ads here.");
  if (r.blockedWords.length) {
    const hit = findWord(content, compiledFor("ads", r.blockedWords), { leet: true, spacing: true });
    if (hit) add("blocked_word", `Your ad contains a word that isn't allowed here (||${hit.replace(/\*/g, "")}||).`);
  }

  // Other links
  if (!r.allowOtherLinks) {
    const bad = extractLinks(content).filter((l) => {
      if (isInviteHost(l.host) && !l.masked) return false;
      if (hostMatches(l.host, r.allowedDomains)) return false;
      return true;
    });
    // Shortener links that resolved to an invite count as invites, not as "other links"
    const okShort = new Set(ctx.resolvedShortenerUrls ?? []);
    const remaining = bad.filter((l) => !(SHORTENERS.has(l.host) && okShort.has(l.url)));
    if (remaining.length) {
      const masked = remaining.some((l) => l.masked);
      add("other_links", masked ? "Hidden (masked) links aren't allowed. Paste the invite directly." : `Only Discord invites are allowed here (found ${remaining.map((l) => l.host).join(", ")}).`);
    }
  }

  // Formatting
  const lines = content.split("\n").length;
  if (r.maxLines > 0 && lines > r.maxLines) add("too_many_lines", `Your ad is too long (${lines}/${r.maxLines} lines).`);
  const emojis = countEmojis(content);
  if (r.maxEmojis > 0 && emojis > r.maxEmojis) add("too_many_emojis", `Too many emojis (${emojis}/${r.maxEmojis}).`);
  if (r.blockMassMentions && ctx.hasEveryoneMention) add("mass_mention", "@everyone and @here aren't allowed in ads.");
  if (r.blockRoleMentions && (ctx.roleMentionCount ?? 0) > 0) add("role_mention", "Role pings aren't allowed in ads.");
  if (r.maxCapsPercent > 0) {
    const caps = capsPercent(content);
    if (caps > r.maxCapsPercent) add("caps", `Too many capital letters (${caps}%).`);
  }
  if (r.requiredKeywords.length) {
    const lower = content.toLowerCase();
    if (!r.requiredKeywords.some((k) => lower.includes(k.toLowerCase())))
      add("missing_keyword", `Your ad must mention one of: ${r.requiredKeywords.join(", ")}.`);
  }

  // Timing
  if (r.minMemberAgeMinutes > 0 && ctx.memberJoinedMinutesAgo != null && ctx.memberJoinedMinutesAgo < r.minMemberAgeMinutes)
    add("new_member", `You need to be in this server for ${r.minMemberAgeMinutes} minutes before advertising.`);
  if (r.userCooldownMinutes > 0 && ctx.minutesSinceUserAd != null && ctx.minutesSinceUserAd < r.userCooldownMinutes)
    add("user_cooldown", `You can post here again in ${Math.ceil(r.userCooldownMinutes - ctx.minutesSinceUserAd)} minutes.`);
  if (r.serverCooldownMinutes > 0 && ctx.minutesSinceServerAd != null && ctx.minutesSinceServerAd < r.serverCooldownMinutes)
    add("server_cooldown", `That server was advertised here recently. Try again in ${Math.ceil(r.serverCooldownMinutes - ctx.minutesSinceServerAd)} minutes.`);
  if (r.blockCrossChannelDuplicates && ctx.liveInOtherChannel)
    add("duplicate_elsewhere", "That server already has a live ad in another channel here.");

  return v;
}
