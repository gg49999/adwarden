import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import type { Command, ModuleName } from "../../core/command.js";
import { COLORS } from "../../core/embeds.js";
import { replyEmbed } from "../../core/reply.js";
import { commands } from "../../registry.js";

const TITLES: Record<ModuleName, string> = {
  general: "⚙️ Setup",
  ads: "📢 Ads",
  sticky: "📌 Sticky messages",
  moderation: "🛡️ Moderation",
  roles: "🎭 Roles",
  antiraid: "🚨 Anti-raid",
  logging: "📜 Logging",
};

const help: Command = {
  module: "general",
  summary: "This list",
  data: new SlashCommandBuilder().setName("help").setDescription("What Adwarden can do"),
  async execute(i) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.brand)
      .setTitle("Adwarden")
      .setDescription(
        "Moderation for advertising servers. New here? Run **`/setup`**.\n" +
          "Anti-raid, scam-link blocking, stale-ad cleanup and logging run automatically and are tuned with `/config`.",
      );
    const byModule = new Map<ModuleName, Command[]>();
    for (const c of commands) byModule.set(c.module, [...(byModule.get(c.module) ?? []), c]);
    for (const [mod, list] of byModule) {
      embed.addFields({ name: TITLES[mod], value: list.map((c) => `\`/${c.data.name}\` ${c.summary}`).join("\n").slice(0, 1024) });
    }
    return replyEmbed(i, embed);
  },
};

const ping: Command = {
  module: "general",
  summary: "Check the bot is alive",
  data: new SlashCommandBuilder().setName("ping").setDescription("Check latency"),
  async execute(i) {
    return replyEmbed(i, new EmbedBuilder().setColor(COLORS.ok).setDescription(`🏓 Gateway ${Math.round(i.client.ws.ping)}ms`));
  },
};

export const generalCommands = [help, ping];
