import { Events, type Message } from "discord.js";
import { client } from "./client.js";
import { db } from "./db.js";
import { requireEnv } from "./env.js";
import { log } from "./logger.js";
import { handleInteraction } from "./core/interactions.js";
import { deployCommands } from "./deploy-commands.js";
import { handleAdEdit, handleAdMessage } from "./modules/ads/handler.js";
import { expireAds, onMemberLeave, onMemberRejoin, postCleanupReports, processLeaveCleanups, revalidateInvites } from "./modules/ads/cleanup.js";
import { loadAdChannels, markAdRemoved, removeAdChannel, getAdRules } from "./modules/ads/store.js";
import { guardJoin, guardMessage } from "./modules/antiraid/guard.js";
import { loadScamDomains } from "./modules/antiraid/scamLinks.js";
import { logMemberJoin, logMemberLeave, logMessageDelete, logMessageEdit } from "./modules/logging/events.js";
import { expireModeration } from "./modules/moderation/jobs.js";
import { expireTempRoles, rolesOnJoin, rolesOnLeave } from "./modules/roles/events.js";
import { filterMessage } from "./modules/wordfilter/handler.js";
import { getSticky, loadStickies, notifyMessage, reconcileStickies, removeSticky, schedule } from "./modules/sticky/service.js";

const token = requireEnv("token");

/** Runs a job and logs (instead of crashing on) errors. */
function every(ms: number, name: string, fn: () => Promise<unknown>) {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (err) {
      log.warn(`Job ${name} failed`, err);
    } finally {
      running = false;
    }
  }, ms).unref();
}

client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  const n = await loadAdChannels();
  log.info(`Watching ${n} ad channel(s)`);
  await loadStickies();
  await loadScamDomains();
  if (process.env.DEPLOY_ON_START !== "false") {
    try {
      log.info(await deployCommands());
    } catch (err) {
      log.error("Couldn't register slash commands", err);
    }
  }
  await reconcileStickies(true);

  every(60_000, "minute", async () => {
    await processLeaveCleanups();
    await expireAds();
    await expireTempRoles();
    await expireModeration();
  });
  every(5 * 60_000, "sticky-reconcile", () => reconcileStickies(false));
  every(15 * 60_000, "invite-revalidate", revalidateInvites);
  every(24 * 3_600_000, "scam-list", loadScamDomains);
  every(7 * 24 * 3_600_000, "weekly-report", postCleanupReports);
  log.info("Ready.");
});

client.on(Events.MessageCreate, async (message: Message) => {
  try {
    if (!message.inGuild()) return;
    if (message.author.id === client.user?.id) return;
    if (!message.author.bot && !message.webhookId) {
      if (await guardMessage(message)) return;
      if (await filterMessage(message)) return;
      if (await handleAdMessage(message)) return;
    }
    notifyMessage(message);
  } catch (err) {
    log.error("messageCreate failed", err);
  }
});

client.on(Events.MessageUpdate, async (before, after) => {
  try {
    const msg = after.partial ? await after.fetch().catch(() => null) : after;
    if (!msg?.inGuild() || msg.author.bot) return;
    await logMessageEdit(before, msg);
    if (before.content !== msg.content && (await filterMessage(msg, true))) return;
    if (getAdRules(msg.channelId)) await handleAdEdit(msg);
  } catch (err) {
    log.error("messageUpdate failed", err);
  }
});

client.on(Events.MessageDelete, async (message) => {
  try {
    if (!message.inGuild()) return;
    const sticky = getSticky(message.channelId);
    if (sticky?.messageId === message.id) {
      schedule(message.channelId, 1000); // someone deleted the sticky: put it back
      return;
    }
    await markAdRemoved(message.id, "message deleted");
    await logMessageDelete(message);
  } catch (err) {
    log.error("messageDelete failed", err);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await guardJoin(member);
    await rolesOnJoin(member);
    await onMemberRejoin(member.guild.id, member.id);
    await logMemberJoin(member);
  } catch (err) {
    log.error("guildMemberAdd failed", err);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await rolesOnLeave(member);
    await onMemberLeave(member.guild.id, member.id);
    await logMemberLeave(member);
  } catch (err) {
    log.error("guildMemberRemove failed", err);
  }
});

client.on(Events.ChannelDelete, async (channel) => {
  if (channel.isDMBased()) return;
  if (getAdRules(channel.id)) await removeAdChannel(channel.id);
  if (getSticky(channel.id)) await removeSticky(channel.id);
});

client.on(Events.GuildCreate, (g) => log.info(`Joined server ${g.name} (${g.id})`));
client.on(Events.InteractionCreate, handleInteraction);
client.on(Events.Error, (err) => log.error("Client error", err));
process.on("unhandledRejection", (err) => log.error("Unhandled rejection", err));

async function shutdown() {
  log.info("Shutting down…");
  await client.destroy();
  await db.$disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(token).catch((err) => {
  if (String(err?.message ?? err).includes("disallowed intents")) {
    log.error(
      "Discord refused the connection: privileged intents are off.\n" +
        "Open https://discord.com/developers/applications → your app → Bot, and turn on\n" +
        "SERVER MEMBERS INTENT and MESSAGE CONTENT INTENT, then start the bot again.",
    );
  } else {
    log.error("Login failed. Check DISCORD_TOKEN in .env.", err);
  }
  process.exit(1);
});
