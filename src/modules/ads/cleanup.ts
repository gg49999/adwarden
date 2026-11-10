/**
 * Stale ad cleanup: ads whose author left, whose invite died, that expired,
 * or that advertise a server that was just blocklisted.
 */
import { EmbedBuilder, type Guild } from "discord.js";
import type { Ad } from "@prisma/client";
import { client } from "../../client.js";
import { db } from "../../db.js";
import { COLORS } from "../../core/embeds.js";
import { getConfig } from "../../core/guildConfig.js";
import { log } from "../../logger.js";
import { sendLog } from "../logging/logs.js";
import { resolveInvite } from "./inviteResolver.js";
import { markAdRemoved } from "./store.js";

async function deleteAdMessage(ad: Ad): Promise<boolean> {
  const ch = await client.channels.fetch(ad.channelId).catch(() => null);
  if (!ch?.isTextBased()) return true; // channel gone: ad is gone too
  return ch.messages.delete(ad.messageId).then(
    () => true,
    (err: { code?: number }) => err?.code === 10008, // already deleted
  );
}

async function removeAds(ads: Ad[], reason: string, status: "removed" | "expired" = "removed") {
  let n = 0;
  for (const ad of ads) {
    if (await deleteAdMessage(ad)) {
      await markAdRemoved(ad.messageId, reason, status);
      n++;
    }
  }
  return n;
}

// ---- Author left -----------------------------------------------------------

export async function onMemberLeave(guildId: string, userId: string) {
  const cfg = await getConfig(guildId);
  if (!cfg.modules.ads || !cfg.ads.deleteOnLeave) return;
  const live = await db.ad.count({ where: { guildId, authorId: userId, status: "live" } });
  if (!live) return;
  const runAt = new Date(Date.now() + cfg.ads.leaveGraceMinutes * 60_000);
  await db.leaveCleanup.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, runAt },
    update: { runAt },
  });
  if (cfg.ads.leaveGraceMinutes === 0) await processLeaveCleanups();
}

export async function onMemberRejoin(guildId: string, userId: string) {
  await db.leaveCleanup.deleteMany({ where: { guildId, userId } });
}

export async function processLeaveCleanups() {
  const due = await db.leaveCleanup.findMany({ where: { runAt: { lte: new Date() } }, take: 50 });
  for (const job of due) {
    await db.leaveCleanup.delete({ where: { guildId_userId: { guildId: job.guildId, userId: job.userId } } }).catch(() => {});
    const guild = client.guilds.cache.get(job.guildId);
    if (!guild) continue;
    // Still gone?
    if (await guild.members.fetch(job.userId).catch(() => null)) continue;
    const ads = await db.ad.findMany({ where: { guildId: job.guildId, authorId: job.userId, status: "live" } });
    const n = await removeAds(ads, "author left");
    if (n) {
      bumpStat(job.guildId, "left", n);
      await sendLog(guild, "ads", new EmbedBuilder().setColor(COLORS.muted).setDescription(`🧹 Removed ${n} ad(s) from <@${job.userId}>, who left the server.`));
    }
  }
}

// ---- Dead invites ------------------------------------------------------------

export async function revalidateInvites() {
  const oldest = await db.ad.findMany({
    where: { status: "live", inviteCode: { not: null }, lastCheckedAt: { lt: new Date(Date.now() - 3_600_000) } },
    orderBy: { lastCheckedAt: "asc" },
    take: 40,
  });
  for (const ad of oldest) {
    const cfg = await getConfig(ad.guildId);
    if (Date.now() - ad.lastCheckedAt.getTime() < cfg.ads.revalidateHours * 3_600_000) continue;
    await db.ad.update({ where: { messageId: ad.messageId }, data: { lastCheckedAt: new Date() } });
    if (!cfg.modules.ads || !cfg.ads.deleteDeadInvites) continue;
    const inv = await resolveInvite(ad.inviteCode!, { fresh: true });
    if (inv.valid) continue;
    if (await removeAds([ad], "invite expired")) {
      bumpStat(ad.guildId, "dead", 1);
      const guild = client.guilds.cache.get(ad.guildId);
      if (guild)
        await sendLog(guild, "ads", new EmbedBuilder().setColor(COLORS.muted).setDescription(`🧹 Removed an ad by <@${ad.authorId}> in <#${ad.channelId}>: invite \`${ad.inviteCode}\` no longer works.`));
    }
  }
}

// ---- Expiry --------------------------------------------------------------------

export async function expireAds() {
  const due = await db.ad.findMany({ where: { status: "live", expiresAt: { lte: new Date() } }, take: 50 });
  for (const ad of due) {
    if (await removeAds([ad], "expired", "expired")) {
      bumpStat(ad.guildId, "expired", 1);
      const user = await client.users.fetch(ad.authorId).catch(() => null);
      const guild = client.guilds.cache.get(ad.guildId);
      await user?.send(`⌛ Your ad${ad.targetName ? ` for **${ad.targetName}**` : ""} in **${guild?.name ?? "a server"}** expired and was removed. You're welcome to post a fresh one.`).catch(() => {});
    }
  }
}

// ---- Blocklist -----------------------------------------------------------------

export async function removeAdsForServer(guild: Guild, targetGuildId: string) {
  const ads = await db.ad.findMany({ where: { guildId: guild.id, targetGuildId, status: "live" } });
  return removeAds(ads, "server blocklisted");
}

// ---- Weekly report ------------------------------------------------------------

const stats = new Map<string, { left: number; dead: number; expired: number }>();
function bumpStat(guildId: string, key: "left" | "dead" | "expired", n: number) {
  const s = stats.get(guildId) ?? { left: 0, dead: 0, expired: 0 };
  s[key] += n;
  stats.set(guildId, s);
}

export async function postCleanupReports() {
  for (const [guildId, s] of stats) {
    const total = s.left + s.dead + s.expired;
    const guild = client.guilds.cache.get(guildId);
    if (!total || !guild) continue;
    await sendLog(
      guild,
      "ads",
      new EmbedBuilder()
        .setColor(COLORS.info)
        .setTitle("🧹 Weekly cleanup report")
        .setDescription(`Removed **${total}** stale ads: ${s.left} from members who left, ${s.dead} with dead invites, ${s.expired} expired.`),
    );
  }
  stats.clear();
  log.info("Posted weekly cleanup reports");
}
