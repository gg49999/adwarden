import { client } from "../../client.js";
import { db } from "../../db.js";
import { createCase } from "./service.js";

/** Lifts temp bans and closes expired ad bans. */
export async function expireModeration() {
  const now = new Date();
  const bans = await db.case.findMany({ where: { type: "tempban", active: true, expiresAt: { lte: now } }, take: 25 });
  for (const c of bans) {
    await db.case.update({ where: { id: c.id }, data: { active: false } });
    const guild = client.guilds.cache.get(c.guildId);
    if (!guild) continue;
    const ok = await guild.members.unban(c.userId, `Temp ban (case #${c.number}) expired`).then(() => true, () => false);
    if (ok) {
      const user = await client.users.fetch(c.userId).catch(() => null);
      if (user) await createCase({ guild, type: "unban", user, mod: client.user!, reason: `Temp ban #${c.number} expired` });
    }
  }
  await db.case.updateMany({ where: { type: "adban", active: true, expiresAt: { lte: now } }, data: { active: false } });
}
