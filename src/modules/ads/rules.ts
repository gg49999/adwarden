import { z } from "zod";

/** Per-channel ad rule profile. Every field has a default so partial JSON is valid. */
export const ChannelRulesSchema = z.object({
  requireInvite: z.boolean().default(true),
  maxInvites: z.number().int().min(0).default(1),
  /** Characters of text required besides links/invites. Catches "link only" posts. */
  minDescriptionChars: z.number().int().min(0).default(30),
  /** Max characters of description text (links not counted). 0 = no limit. */
  maxDescriptionChars: z.number().int().min(0).max(4000).default(0),
  /** Max total characters of the whole message. 0 = no limit. */
  maxChars: z.number().int().min(0).max(4000).default(0),
  allowAttachments: z.boolean().default(true),
  allowOtherLinks: z.boolean().default(false),
  allowedDomains: z.array(z.string()).default([]),
  maxLines: z.number().int().min(0).default(30),
  maxEmojis: z.number().int().min(0).default(0),
  blockMassMentions: z.boolean().default(true),
  blockRoleMentions: z.boolean().default(true),
  /** 0-100, percent of letters that are capitals. 0 = off. */
  maxCapsPercent: z.number().int().min(0).max(100).default(0),
  requiredKeywords: z.array(z.string()).default([]),
  /** Words that may not appear in ads here (same syntax as the word filter: word, word*, *word*). */
  blockedWords: z.array(z.string()).default([]),
  blockNsfwServers: z.boolean().default(true),
  minServerMembers: z.number().int().min(0).default(0),
  /** Member must have been in this server this many minutes before advertising. */
  minMemberAgeMinutes: z.number().int().min(0).default(0),
  userCooldownMinutes: z.number().int().min(0).default(120),
  serverCooldownMinutes: z.number().int().min(0).default(120),
  /** Same server already has a live ad in another channel here. */
  blockCrossChannelDuplicates: z.boolean().default(false),
  /** Ads are deleted after this many days. 0 = never. */
  expiryDays: z.number().int().min(0).default(0),
  /** What to do when a rule fails. */
  action: z.enum(["delete_dm", "delete", "review", "log"]).default("delete_dm"),
  /** Send every passing ad to the review queue too (unless the poster is trusted). */
  reviewAll: z.boolean().default(false),
  warnOnViolation: z.boolean().default(false),
  timeoutMinutesOnViolation: z.number().int().min(0).max(40320).default(0),
});

export type ChannelRules = z.infer<typeof ChannelRulesSchema>;
export type RuleKey = keyof ChannelRules;

export const PRESETS = {
  strict: {
    minDescriptionChars: 80,
    maxLines: 20,
    maxEmojis: 15,
    maxCapsPercent: 60,
    minServerMembers: 10,
    minMemberAgeMinutes: 30,
    userCooldownMinutes: 360,
    serverCooldownMinutes: 360,
    blockCrossChannelDuplicates: true,
    warnOnViolation: true,
    reviewAll: false,
  },
  standard: {},
  relaxed: {
    minDescriptionChars: 10,
    maxLines: 50,
    userCooldownMinutes: 30,
    serverCooldownMinutes: 30,
    blockRoleMentions: false,
  },
} satisfies Record<string, Partial<ChannelRules>>;

export type PresetName = keyof typeof PRESETS;

export function presetRules(name: PresetName): ChannelRules {
  return ChannelRulesSchema.parse(PRESETS[name]);
}

export function parseRules(raw: unknown): ChannelRules {
  const r = ChannelRulesSchema.safeParse(raw ?? {});
  return r.success ? r.data : ChannelRulesSchema.parse({});
}

export const RULE_HELP: Record<RuleKey, string> = {
  requireInvite: "Ad must contain a Discord invite",
  maxInvites: "Most invites allowed in one ad",
  minDescriptionChars: "Minimum text besides links (stops link-only posts)",
  maxDescriptionChars: "Maximum description length (0 = no limit)",
  maxChars: "Maximum total message length (0 = no limit)",
  allowAttachments: "Allow images/files in ads",
  allowOtherLinks: "Allow non-invite links",
  allowedDomains: "Domains allowed even when other links are off (comma list)",
  maxLines: "Most lines allowed (0 = no limit)",
  maxEmojis: "Most emojis allowed (0 = no limit)",
  blockMassMentions: "Block @everyone / @here",
  blockRoleMentions: "Block role pings",
  maxCapsPercent: "Max % of capital letters (0 = off)",
  requiredKeywords: "At least one of these words must appear (comma list)",
  blockedWords: "Words not allowed in ads here (comma list, * wildcards)",
  blockNsfwServers: "Reject invites to NSFW / age-restricted servers",
  minServerMembers: "Advertised server needs at least this many members",
  minMemberAgeMinutes: "Poster must have been here this many minutes",
  userCooldownMinutes: "Minutes between ads from the same user in this channel",
  serverCooldownMinutes: "Minutes between ads for the same server in this channel",
  blockCrossChannelDuplicates: "Reject if the same server has a live ad in another channel",
  expiryDays: "Delete ads after this many days (0 = never)",
  action: "On violation: delete_dm, delete, review or log",
  reviewAll: "Send every ad to the review queue",
  warnOnViolation: "Give a warn case on violation",
  timeoutMinutesOnViolation: "Time out the poster on violation (0 = off)",
};

/** Parses a user-typed value for a rule. Returns the new rules or an error string. */
export function setRule(rules: ChannelRules, key: RuleKey, rawValue: string): ChannelRules | string {
  const current = rules[key];
  let value: unknown;
  const v = rawValue.trim();
  if (typeof current === "boolean") {
    if (/^(true|on|yes|1|enable|enabled)$/i.test(v)) value = true;
    else if (/^(false|off|no|0|disable|disabled)$/i.test(v)) value = false;
    else return `\`${key}\` needs on or off.`;
  } else if (typeof current === "number") {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0) return `\`${key}\` needs a whole number, 0 or more.`;
    value = n;
  } else if (Array.isArray(current)) {
    value = v === "" || v === "-" || /^none$/i.test(v) ? [] : [...new Set(v.split(/[,\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean))];
  } else {
    value = v;
  }
  const next = ChannelRulesSchema.safeParse({ ...rules, [key]: value });
  if (!next.success) return `Invalid value for \`${key}\`: ${next.error.issues[0]?.message ?? "rejected"}`;
  return next.data;
}

/** Short human summary shown in stickies and DMs. */
export function summarizeRules(r: ChannelRules): string {
  const bits: string[] = [];
  if (r.requireInvite) bits.push(r.maxInvites === 1 ? "1 invite" : `invite required (max ${r.maxInvites})`);
  if (r.minDescriptionChars && r.maxDescriptionChars) bits.push(`${r.minDescriptionChars}-${r.maxDescriptionChars} chars of description`);
  else if (r.minDescriptionChars) bits.push(`min ${r.minDescriptionChars} chars of description`);
  else if (r.maxDescriptionChars) bits.push(`max ${r.maxDescriptionChars} chars of description`);
  if (r.maxChars) bits.push(`max ${r.maxChars} chars total`);
  if (!r.allowAttachments) bits.push("no images/files");
  if (!r.allowOtherLinks) bits.push(r.allowedDomains.length ? `links only from ${r.allowedDomains.join(", ")}` : "no other links");
  if (r.userCooldownMinutes) bits.push(`${formatMinutes(r.userCooldownMinutes)} cooldown`);
  if (r.blockNsfwServers) bits.push("SFW servers only");
  if (r.minServerMembers) bits.push(`${r.minServerMembers}+ members`);
  if (r.blockMassMentions || r.blockRoleMentions) bits.push("no pings");
  if (r.requiredKeywords.length) bits.push(`must mention: ${r.requiredKeywords.join(" / ")}`);
  if (r.expiryDays) bits.push(`ads expire after ${r.expiryDays}d`);
  return bits.join(" · ");
}

function formatMinutes(m: number) {
  if (m % 1440 === 0) return `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

/** Groups used by the /settings panel. */
export const BOOLEAN_RULES = [
  "requireInvite", "allowOtherLinks", "allowAttachments", "blockMassMentions", "blockRoleMentions",
  "blockNsfwServers", "blockCrossChannelDuplicates", "reviewAll", "warnOnViolation",
] as const satisfies readonly RuleKey[];

export const LIMIT_RULES = ["minDescriptionChars", "maxDescriptionChars", "maxChars", "maxLines", "maxEmojis"] as const satisfies readonly RuleKey[];
export const TIMING_RULES = ["userCooldownMinutes", "serverCooldownMinutes", "minMemberAgeMinutes", "minServerMembers", "expiryDays"] as const satisfies readonly RuleKey[];
export const EXTRA_NUMBER_RULES = ["maxInvites", "maxCapsPercent", "timeoutMinutesOnViolation"] as const satisfies readonly RuleKey[];
export const LIST_RULES = ["blockedWords", "allowedDomains", "requiredKeywords"] as const satisfies readonly RuleKey[];
