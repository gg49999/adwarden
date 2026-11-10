import { z } from "zod";
import { db, parseJson } from "../db.js";

const snowflake = z.string().regex(/^\d{15,22}$/);

export const GuildConfigSchema = z.object({
  logChannels: z
    .object({
      mod: snowflake.optional(),
      ads: snowflake.optional(),
      messages: snowflake.optional(),
      members: snowflake.optional(),
    })
    .prefault({}),
  reviewChannelId: snowflake.optional(),
  appealChannelId: snowflake.optional(),
  reportChannelId: snowflake.optional(),
  modules: z
    .object({
      ads: z.boolean().default(true),
      sticky: z.boolean().default(true),
      moderation: z.boolean().default(true),
      roles: z.boolean().default(true),
      antiraid: z.boolean().default(true),
      logging: z.boolean().default(true),
    })
    .prefault({}),
  ads: z
    .object({
      /** Staff with Manage Messages skip ad checks. */
      exemptStaff: z.boolean().default(true),
      deleteOnLeave: z.boolean().default(true),
      leaveGraceMinutes: z.number().int().min(0).max(1440).default(10),
      deleteDeadInvites: z.boolean().default(true),
      revalidateHours: z.number().int().min(1).max(168).default(6),
      dmOnRemoval: z.boolean().default(true),
      /** Reputation needed to skip review when a channel has reviewAll on. 0 = nobody skips. */
      trustedThreshold: z.number().int().min(0).default(10),
      trustedRoleId: snowflake.optional(),
    })
    .prefault({}),
  escalation: z
    .object({
      enabled: z.boolean().default(true),
      steps: z
        .array(
          z.object({
            warns: z.number().int().min(1),
            action: z.enum(["timeout", "kick", "ban"]),
            durationMs: z.number().int().optional(),
          }),
        )
        .default([
          { warns: 3, action: "timeout", durationMs: 3_600_000 },
          { warns: 5, action: "timeout", durationMs: 86_400_000 },
          { warns: 7, action: "ban" },
        ]),
    })
    .prefault({}),
  antiraid: z
    .object({
      minAccountAgeDays: z.number().int().min(0).max(365).default(0),
      youngAccountAction: z.enum(["quarantine", "kick", "log"]).default("log"),
      quarantineRoleId: snowflake.optional(),
      joinBurstCount: z.number().int().min(0).default(10),
      joinBurstSeconds: z.number().int().min(1).default(10),
      autoLockdown: z.boolean().default(false),
      scamLinks: z.boolean().default(true),
      scamAction: z.enum(["delete", "delete_timeout", "delete_ban"]).default("delete_timeout"),
      maxMentions: z.number().int().min(0).default(8),
      crossChannelSpam: z.boolean().default(true),
    })
    .prefault({}),
  wordFilter: z
    .object({
      enabled: z.boolean().default(false),
      /** Entries: word (whole word), word* (prefix), *word (suffix), *word* (anywhere) */
      words: z.array(z.string().max(60)).max(1000).default([]),
      action: z.enum(["delete", "delete_warn", "delete_timeout", "log"]).default("delete"),
      timeoutMinutes: z.number().int().min(1).max(40320).default(10),
      /** all = every channel; ads = ad channels only; selected = only channelIds */
      scope: z.enum(["all", "ads", "selected"]).default("all"),
      channelIds: z.array(snowflake).max(25).default([]),
      exemptChannelIds: z.array(snowflake).max(25).default([]),
      exemptRoleIds: z.array(snowflake).max(25).default([]),
      exemptStaff: z.boolean().default(true),
      leet: z.boolean().default(true),
      spacing: z.boolean().default(true),
      dmUser: z.boolean().default(true),
      checkEdits: z.boolean().default(true),
    })
    .prefault({}),
  autoRoleIds: z.array(snowflake).default([]),
  autoRoleDelaySeconds: z.number().int().min(0).max(3600).default(0),
  /** Roles restored when a member rejoins (e.g. quarantine, ad-banned). */
  persistRoleIds: z.array(snowflake).default([]),
});

export type GuildConfig = z.infer<typeof GuildConfigSchema>;

const cache = new Map<string, GuildConfig>();

export function parseGuildConfig(raw: unknown): GuildConfig {
  const parsed = GuildConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : GuildConfigSchema.parse({});
}

export async function getConfig(guildId: string): Promise<GuildConfig> {
  const hit = cache.get(guildId);
  if (hit) return hit;
  const row = await db.guild.upsert({ where: { id: guildId }, create: { id: guildId }, update: {} });
  const cfg = parseGuildConfig(parseJson(row.config, {}));
  cache.set(guildId, cfg);
  return cfg;
}

export async function updateConfig(
  guildId: string,
  mutate: (cfg: GuildConfig) => void,
): Promise<GuildConfig> {
  const cfg = structuredClone(await getConfig(guildId));
  mutate(cfg);
  const valid = GuildConfigSchema.parse(cfg);
  await db.guild.update({ where: { id: guildId }, data: { config: JSON.stringify(valid) } });
  cache.set(guildId, valid);
  return valid;
}

export async function replaceConfig(guildId: string, raw: unknown): Promise<GuildConfig> {
  const valid = GuildConfigSchema.parse(raw);
  await db.guild.upsert({
    where: { id: guildId },
    create: { id: guildId, config: JSON.stringify(valid) },
    update: { config: JSON.stringify(valid) },
  });
  cache.set(guildId, valid);
  return valid;
}
