import { describe, expect, it } from "vitest";
import { compileWords, findWord, parseWordList } from "../src/modules/wordfilter/filter.js";
import { evaluateAd } from "../src/modules/ads/engine.js";
import { ChannelRulesSchema } from "../src/modules/ads/rules.js";

const both = { leet: true, spacing: true };
const none = { leet: false, spacing: false };
const find = (text: string, words: string[], opts = both) => findWord(text, compileWords(words), opts);

describe("word filter matching", () => {
  it("matches whole words only by default", () => {
    expect(find("you are an ass", ["ass"])).toBe("ass");
    expect(find("first class seats", ["ass"])).toBeNull();
  });

  it("supports prefix, suffix and anywhere wildcards", () => {
    expect(find("total scammer here", ["scam*"])).toBe("scam*");
    expect(find("antiscam team", ["scam*"])).toBeNull();
    expect(find("antiscam team", ["*scam"])).toBe("*scam");
    expect(find("freerobuxnow", ["*robux*"])).toBe("*robux*");
  });

  it("matches multi-word phrases with any spacing", () => {
    expect(find("get FREE    nitro today", ["free nitro"])).toBe("free nitro");
  });

  it("is case and accent insensitive", () => {
    expect(find("SCÄM alert", ["scam"])).toBe("scam");
  });

  it("catches fullwidth / styled letters", () => {
    expect(find("ｓｃａｍ", ["scam"])).toBe("scam");
  });

  it("catches leetspeak only when enabled", () => {
    expect(find("sc4m link", ["scam"])).toBe("scam");
    expect(find("$c@m link", ["scam"])).toBe("scam");
    expect(find("sc4m link", ["scam"], none)).toBeNull();
  });

  it("catches spaced and stretched letters only when enabled", () => {
    expect(find("this is a s c a m", ["scam"])).toBe("scam");
    expect(find("s.c.a.m", ["scam"])).toBe("scam");
    expect(find("scaaaaam", ["scam"])).toBe("scam");
    expect(find("s c a m", ["scam"], none)).toBeNull();
  });

  it("does not glue normal words together", () => {
    // "is a scam" must not become "isascam" and trip a word like "sas"
    expect(find("this is a nice server", ["sas"])).toBeNull();
  });

  it("parses user-typed lists", () => {
    expect(parseWordList("Bad, worse\n  SCAM* ,x, bad")).toEqual(["bad", "worse", "scam*"]);
  });
});

describe("new ad limits", () => {
  const desc = "A friendly gaming community with weekly events, giveaways and voice chats.";
  const run = (rules: object, extra: object = {}) =>
    evaluateAd({
      content: `${desc}\nhttps://discord.gg/abc123`,
      rules: ChannelRulesSchema.parse(rules),
      invites: [{ code: "abc123", valid: true, guildId: "1", guildName: "X", memberCount: 50 }],
      ...extra,
    }).map((v) => v.rule);

  it("enforces max description length", () => {
    expect(run({ maxDescriptionChars: 20 })).toContain("long_description");
    expect(run({ maxDescriptionChars: 500 })).not.toContain("long_description");
  });
  it("enforces max total length", () => {
    expect(run({ maxChars: 50 })).toContain("too_long");
  });
  it("blocks attachments when disabled", () => {
    expect(run({ allowAttachments: false }, { attachmentCount: 1 })).toContain("attachments");
    expect(run({}, { attachmentCount: 1 })).not.toContain("attachments");
  });
  it("applies per-ruleset blocked words", () => {
    expect(run({ blockedWords: ["giveaway*"] })).toContain("blocked_word");
    expect(run({ blockedWords: ["nsfw"] })).not.toContain("blocked_word");
  });
});
