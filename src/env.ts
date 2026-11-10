import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function optional(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

export const env = {
  token: optional("DISCORD_TOKEN"),
  clientId: optional("CLIENT_ID"),
  devGuildId: optional("DEV_GUILD_ID"),
  scamListUrl: optional("SCAM_LIST_URL"),
  logLevel: (optional("LOG_LEVEL") ?? "info") as "debug" | "info" | "warn" | "error",
};

export function requireEnv(name: "token" | "clientId"): string {
  const v = env[name];
  if (!v) {
    const key = name === "token" ? "DISCORD_TOKEN" : "CLIENT_ID";
    throw new Error(`${key} is not set. Copy .env.example to .env and fill it in.`);
  }
  return v;
}
