import { Client, GatewayIntentBits, Partials } from "discord.js";

export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: join/leave, role persistence, bulk roles
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged: reading ad text
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
  allowedMentions: { parse: ["users"], repliedUser: false },
});
