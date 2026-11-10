import { PermissionFlagsBits, type Guild, type GuildMember, type GuildTextBasedChannel } from "discord.js";
import { UserError } from "./reply.js";

/** Checks that `actor` (and the bot) can act on `target` given role hierarchy. Throws UserError otherwise. */
export function assertCanModerate(guild: Guild, actor: GuildMember, target: GuildMember) {
  const me = guild.members.me;
  if (!me) throw new UserError("I can't see my own member record. Try again in a moment.");
  if (target.id === actor.id) throw new UserError("You can't do that to yourself.");
  if (target.id === guild.ownerId) throw new UserError("You can't take action against the server owner.");
  if (target.id === me.id) throw new UserError("I can't take action against myself.");
  if (actor.id !== guild.ownerId && target.roles.highest.comparePositionTo(actor.roles.highest) >= 0)
    throw new UserError(`${target} has a role equal to or higher than yours.`);
  if (target.roles.highest.comparePositionTo(me.roles.highest) >= 0)
    throw new UserError(`${target} has a role equal to or higher than mine. Move my role above theirs.`);
}

export function assertBotPerms(channel: GuildTextBasedChannel, ...perms: bigint[]) {
  const me = channel.guild.members.me;
  const have = me ? channel.permissionsFor(me) : null;
  const missing = perms.filter((p) => !have?.has(p));
  if (missing.length) {
    const names = missing.map((p) => Object.entries(PermissionFlagsBits).find(([, v]) => v === p)?.[0] ?? String(p));
    throw new UserError(`I'm missing permissions in ${channel}: ${names.join(", ")}`);
  }
}

export function isStaff(member: GuildMember | null | undefined): boolean {
  return !!member?.permissions.has(PermissionFlagsBits.ManageMessages);
}

export function canManageRole(guild: Guild, roleId: string, actor?: GuildMember): string | null {
  const role = guild.roles.cache.get(roleId);
  const me = guild.members.me;
  if (!role) return "That role no longer exists.";
  if (role.managed) return `${role} is managed by an integration and can't be assigned.`;
  if (role.id === guild.id) return "You can't assign @everyone.";
  if (!me || role.comparePositionTo(me.roles.highest) >= 0) return `${role} is above my highest role. Move my role higher.`;
  if (actor && actor.id !== guild.ownerId && role.comparePositionTo(actor.roles.highest) >= 0)
    return `${role} is equal to or above your highest role.`;
  return null;
}
