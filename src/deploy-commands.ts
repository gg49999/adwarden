/**
 * Registers slash commands with Discord.
 * With DEV_GUILD_ID set: registers to that server only (instant). Otherwise globally.
 */
import { REST, Routes } from "discord.js";
import { env, requireEnv } from "./env.js";
import { commands } from "./registry.js";

export async function deployCommands() {
  const token = requireEnv("token");
  const clientId = requireEnv("clientId");
  const rest = new REST().setToken(token);
  const body = commands.map((c) => c.data.toJSON());
  if (env.devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, env.devGuildId), { body });
    return `Registered ${body.length} commands to server ${env.devGuildId} (instant).`;
  }
  await rest.put(Routes.applicationCommands(clientId), { body });
  return `Registered ${body.length} commands globally (may take a few minutes to show up).`;
}

const isMain = process.argv[1] && /deploy-commands\.(ts|js)$/.test(process.argv[1]);
if (isMain) {
  deployCommands()
    .then((msg) => {
      console.log(msg);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Failed to register commands:", err);
      process.exit(1);
    });
}
