import { describe, expect, it } from "vitest";
import { evaluateAd, type AdContext, type ResolvedInvite } from "../src/modules/ads/engine.js";
import { ChannelRulesSchema, presetRules, setRule, type ChannelRules } from "../src/modules/ads/rules.js";

const goodInvite: ResolvedInvite = { code: "abc123", valid: true, guildId: "111111111111111111", guildName: "Cozy Corner", memberCount: 500, nsfwLevel: 0 };
const desc = "A friendly gaming community with weekly events, giveaways and voice chats.";

function run(over: Partial<AdContext> & { rules?: Partial<ChannelRules> } = {}) {
  const { rules, ...rest } = over;
  return evaluateAd({
    content: `${desc}\nhttps://discord.gg/abc123`,
    rules: ChannelRulesSchema.parse(rules ?? {}),
    invites: [goodInvite],
    ...rest,
  }).map((v) => v.rule);
}

describe("evaluateAd", () => {
  it("passes a normal ad", () => {
    expect(run()).toEqual([]);
  });

  it("flags a link-only post", () => {
    expect(run({ content: "https://discord.gg/abc123" })).toContain("link_only");
  });

  it("flags a too-short description", () => {
    expect(run({ content: "join us pls https://discord.gg/abc123" })).toContain("short_description");
  });

  it("requires an invite", () => {
    expect(run({ content: desc, invites: [] })).toContain("no_invite");
  });

  it("limits invite count", () => {
    expect(run({ invites: [goodInvite, { ...goodInvite, code: "def456" }] })).toContain("too_many_invites");
  });

  it("flags invalid invites", () => {
    expect(run({ invites: [{ code: "dead", valid: false }] })).toContain("invalid_invite");
  });

  it("blocks blocklisted servers by ID", () => {
    expect(run({ blockedServerIds: new Set([goodInvite.guildId!]) })).toContain("blocked_server");
  });

  it("blocks NSFW servers when configured", () => {
    expect(run({ invites: [{ ...goodInvite, nsfwLevel: 3 }] })).toContain("nsfw_server");
    expect(run({ invites: [{ ...goodInvite, nsfwLevel: 3 }], rules: { blockNsfwServers: false } })).not.toContain("nsfw_server");
  });

  it("enforces minimum server size", () => {
    expect(run({ rules: { minServerMembers: 1000 } })).toContain("too_few_members");
  });

  it("rejects other links, but allows listed domains", () => {
    const content = `${desc}\nhttps://discord.gg/abc123 https://youtube.com/watch?v=x`;
    expect(run({ content })).toContain("other_links");
    expect(run({ content, rules: { allowedDomains: ["youtube.com"] } })).not.toContain("other_links");
    expect(run({ content, rules: { allowOtherLinks: true } })).not.toContain("other_links");
  });

  it("catches masked links", () => {
    expect(run({ content: `${desc}\n[click me](https://evil.example/x) https://discord.gg/abc123` })).toContain("other_links");
  });

  it("treats shortener links that resolved to an invite as invites", () => {
    const content = `${desc}\nhttps://dsc.gg/cozy`;
    expect(run({ content, resolvedShortenerUrls: ["https://dsc.gg/cozy"] })).not.toContain("other_links");
    expect(run({ content })).toContain("other_links");
  });

  it("blocks mass and role mentions", () => {
    expect(run({ hasEveryoneMention: true })).toContain("mass_mention");
    expect(run({ roleMentionCount: 1 })).toContain("role_mention");
  });

  it("enforces cooldowns", () => {
    expect(run({ minutesSinceUserAd: 10 })).toContain("user_cooldown");
    expect(run({ minutesSinceUserAd: 500 })).not.toContain("user_cooldown");
    expect(run({ minutesSinceServerAd: 10 })).toContain("server_cooldown");
  });

  it("enforces member age", () => {
    expect(run({ rules: { minMemberAgeMinutes: 30 }, memberJoinedMinutesAgo: 5 })).toContain("new_member");
  });

  it("enforces caps limit", () => {
    expect(run({ content: `${desc.toUpperCase()}\nhttps://discord.gg/abc123`, rules: { maxCapsPercent: 60 } })).toContain("caps");
  });

  it("requires keywords when configured", () => {
    expect(run({ rules: { requiredKeywords: ["anime"] } })).toContain("missing_keyword");
    expect(run({ rules: { requiredKeywords: ["gaming"] } })).not.toContain("missing_keyword");
  });

  it("short-circuits for ad-banned users", () => {
    expect(run({ userAdBanned: true })).toEqual(["ad_banned"]);
  });

  it("flags cross-channel duplicates when enabled", () => {
    expect(run({ liveInOtherChannel: true })).not.toContain("duplicate_elsewhere");
    expect(run({ liveInOtherChannel: true, rules: { blockCrossChannelDuplicates: true } })).toContain("duplicate_elsewhere");
  });
});

describe("rules", () => {
  it("presets parse with defaults", () => {
    expect(presetRules("strict").minDescriptionChars).toBe(80);
    expect(presetRules("standard").maxInvites).toBe(1);
  });

  it("setRule parses booleans, numbers and lists", () => {
    const base = presetRules("standard");
    expect((setRule(base, "allowOtherLinks", "on") as ChannelRules).allowOtherLinks).toBe(true);
    expect((setRule(base, "maxLines", "12") as ChannelRules).maxLines).toBe(12);
    expect((setRule(base, "allowedDomains", "YouTube.com, twitch.tv") as ChannelRules).allowedDomains).toEqual(["youtube.com", "twitch.tv"]);
    expect(typeof setRule(base, "maxLines", "-3")).toBe("string");
    expect(typeof setRule(base, "action", "explode")).toBe("string");
  });
});
