import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Guild } from "discord.js";
import { db, parseJson } from "../../db.js";
import { COLORS } from "../../core/embeds.js";
import { sendLog } from "../logging/logs.js";

/** Locks every text channel @everyone can currently send in. Returns count, or null if already locked. */
export async function startLockdown(guild: Guild, reason: string): Promise<number | null> {
  if (await db.lockdown.findUnique({ where: { guildId: guild.id } })) return null;
  const everyone = guild.roles.everyone;
  const targets = guild.channels.cache.filter(
    (c) =>
      (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
      c.permissionsFor(everyone).has(PermissionFlagsBits.ViewChannel) &&
      c.permissionsFor(everyone).has(PermissionFlagsBits.SendMessages) &&
      c.manageable,
  );
  const locked: string[] = [];
  for (const c of targets.values()) {
    if (!("permissionOverwrites" in c)) continue;
    try {
      await c.permissionOverwrites.edit(everyone, { SendMessages: false }, { reason: `Lockdown: ${reason}` });
      locked.push(c.id);
    } catch {
      /* skip channels we can't edit */
    }
  }
  await db.lockdown.create({ data: { guildId: guild.id, channelIds: JSON.stringify(locked) } });
  await sendLog(guild, "mod", new EmbedBuilder().setColor(COLORS.danger).setTitle("🚨 Lockdown started").setDescription(`${reason}\nLocked ${locked.length} channel(s). End it with \`/lockdown end\`.`));
  return locked.length;
}

export async function endLockdown(guild: Guild): Promise<number | null> {
  const row = await db.lockdown.findUnique({ where: { guildId: guild.id } });
  if (!row) return null;
  const ids = parseJson<string[]>(row.channelIds, []);
  let n = 0;
  for (const id of ids) {
    const c = guild.channels.cache.get(id);
    if (!c || !("permissionOverwrites" in c)) continue;
    try {
      await c.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null }, { reason: "Lockdown ended" });
      n++;
    } catch {
      /* ignore */
    }
  }
  await db.lockdown.delete({ where: { guildId: guild.id } });
  await sendLog(guild, "mod", new EmbedBuilder().setColor(COLORS.ok).setTitle("✅ Lockdown ended").setDescription(`Unlocked ${n} channel(s).`));
  return n;
}
