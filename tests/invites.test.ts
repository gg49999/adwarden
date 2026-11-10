import { describe, expect, it } from "vitest";
import { descriptionText, extractInviteCodes, extractLinks, normalize } from "../src/modules/ads/invites.js";
import { isScamHost, looksLikeScam } from "../src/modules/antiraid/scamLinks.js";
import { formatDuration, parseDuration } from "../src/core/duration.js";

describe("invite detection", () => {
  it("finds standard invite formats", () => {
    expect(extractInviteCodes("join https://discord.gg/AbC123 now")).toEqual(["AbC123"]);
    expect(extractInviteCodes("discord.com/invite/xyz-99")).toEqual(["xyz-99"]);
    expect(extractInviteCodes("https://discordapp.com/invite/old")).toEqual(["old"]);
  });

  it("sees through obfuscation", () => {
    expect(extractInviteCodes("discord . gg / sneaky")).toEqual(["sneaky"]);
    expect(extractInviteCodes("discord(dot)gg/sneaky2")).toEqual(["sneaky2"]);
    expect(extractInviteCodes("disc​ord.gg/zw")).toEqual(["zw"]);
  });

  it("dedupes invites", () => {
    expect(extractInviteCodes("discord.gg/a1 discord.gg/a1")).toEqual(["a1"]);
  });

  it("strips zero-width characters", () => {
    expect(normalize("a​b﻿c")).toBe("abc");
  });
});

describe("links", () => {
  it("finds plain and masked links", () => {
    const links = extractLinks("see https://example.com/a. and [here](https://hidden.io/x)");
    expect(links.map((l) => [l.host, l.masked])).toEqual([
      ["hidden.io", true],
      ["example.com", false],
    ]);
  });

  it("measures description without links or markdown", () => {
    expect(descriptionText("**Cool** server! https://discord.gg/abc <@123>")).toBe("Cool server!");
    expect(descriptionText("https://discord.gg/abc")).toBe("");
  });
});

describe("scam detection", () => {
  it("flags look-alike gift domains but not real ones", () => {
    expect(looksLikeScam("dlscord-gift.com")).toBe(true);
    expect(looksLikeScam("discord-nitro.ru")).toBe(true);
    expect(looksLikeScam("discord.com")).toBe(false);
    expect(looksLikeScam("discord.gift")).toBe(false);
    expect(looksLikeScam("youtube.com")).toBe(false);
  });
  it("unknown hosts aren't on the (empty) list", () => {
    expect(isScamHost("example.com")).toBe(false);
  });
});

describe("durations", () => {
  it("parses and formats", () => {
    expect(parseDuration("10m")).toBe(600_000);
    expect(parseDuration("1d12h")).toBe(129_600_000);
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("5x")).toBeNull();
    expect(formatDuration(90_000)).toBe("1m 30s");
  });
});
