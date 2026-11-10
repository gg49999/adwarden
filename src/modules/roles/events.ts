import type { GuildMember, PartialGuildMember } from "discord.js";
import { client } from "../../client.js";
import { db, parseJson } from "../../db.js";
import { getConfig } from "../../core/guildConfig.js";
import { log } from "../../logger.js";

export async function rolesOnJoin(member: GuildMember) {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.modules.roles) return;

  // Restore persisted roles (quarantine, ad-banned, etc.) so leaving doesn't clear them
  const saved = await db.persistedRoles.findUnique({ where: { guildId_userId: { guildId: member.guild.id, userId: member.id } } });
  if (saved) {
    const ids = parseJson<string[]>(saved.roleIds, []).filter((id) => cfg.persistRoleIds.includes(id) && member.guild.roles.cache.has(id));
    if (ids.length) await member.roles.add(ids, "Restoring roles from before they left").catch((e) => log.warn("role restore failed", e));
    await db.persistedRoles.delete({ where: { guildId_userId: { guildId: member.guild.id, userId: member.id } } }).catch(() => {});
  }

  if (!cfg.autoRoleIds.length || member.user.bot) return;
  const give = async () => {
    const fresh = await member.guild.members.fetch(member.id).catch(() => null);
    if (!fresh) return;
    const ids = cfg.autoRoleIds.filter((id) => member.guild.roles.cache.has(id));
    if (ids.length) await fresh.roles.add(ids, "Auto role").catch((e) => log.warn("auto role failed", e));
  };
  if (cfg.autoRoleDelaySeconds > 0) setTimeout(() => void give(), cfg.autoRoleDelaySeconds * 1000);
  else await give();
}

export async function rolesOnLeave(member: GuildMember | PartialGuildMember) {
  const cfg = await getConfig(member.guild.id);
  if (!cfg.persistRoleIds.length) return;
  const keep = member.roles.cache.filter((r) => cfg.persistRoleIds.includes(r.id)).map((r) => r.id);
  if (!keep.length) return;
  await db.persistedRoles.upsert({
    where: { guildId_userId: { guildId: member.guild.id, userId: member.id } },
    create: { guildId: member.guild.id, userId: member.id, roleIds: JSON.stringify(keep) },
    update: { roleIds: JSON.stringify(keep) },
  });
}

export async function expireTempRoles() {
  const due = await db.tempRole.findMany({ where: { expiresAt: { lte: new Date() } }, take: 50 });
  for (const t of due) {
    await db.tempRole.delete({ where: { id: t.id } }).catch(() => {});
    const guild = client.guilds.cache.get(t.guildId);
    const member = await guild?.members.fetch(t.userId).catch(() => null);
    await member?.roles.remove(t.roleId, "Temporary role expired").catch(() => {});
  }
}
