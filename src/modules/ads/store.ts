import { db, parseJson } from "../../db.js";
import { parseRules, type ChannelRules } from "./rules.js";

interface AdChannelEntry {
  guildId: string;
  /** The channel's own rules (used when not linked to a ruleset) */
  rules: ChannelRules;
  rulesetId: string | null;
}
interface RuleSetEntry {
  id: string;
  guildId: string;
  name: string;
  rules: ChannelRules;
}

const adChannels = new Map<string, AdChannelEntry>();
const rulesets = new Map<string, RuleSetEntry>();

export async function loadAdChannels() {
  adChannels.clear();
  rulesets.clear();
  for (const r of await db.ruleSet.findMany()) rulesets.set(r.id, { id: r.id, guildId: r.guildId, name: r.name, rules: parseRules(parseJson(r.rules, {})) });
  for (const row of await db.adChannel.findMany())
    adChannels.set(row.channelId, { guildId: row.guildId, rules: parseRules(parseJson(row.rules, {})), rulesetId: row.rulesetId });
  return adChannels.size;
}

/** The rules that apply in a channel: its ruleset's, or its own. */
export function getAdRules(channelId: string): ChannelRules | undefined {
  const ch = adChannels.get(channelId);
  if (!ch) return undefined;
  if (ch.rulesetId) {
    const rs = rulesets.get(ch.rulesetId);
    if (rs) return rs.rules;
  }
  return ch.rules;
}

export const getAdChannel = (channelId: string) => adChannels.get(channelId);

export const listAdChannels = (guildId: string) =>
  [...adChannels.entries()]
    .filter(([, v]) => v.guildId === guildId)
    .map(([channelId, v]) => ({ channelId, rules: getAdRules(channelId)!, rulesetId: v.rulesetId, ruleset: v.rulesetId ? rulesets.get(v.rulesetId) : undefined }));

/** Sets a channel's own rules (and unlinks it from any ruleset). */
export async function setAdChannel(guildId: string, channelId: string, rules: ChannelRules) {
  await db.adChannel.upsert({
    where: { channelId },
    create: { channelId, guildId, rules: JSON.stringify(rules) },
    update: { rules: JSON.stringify(rules), rulesetId: null },
  });
  adChannels.set(channelId, { guildId, rules, rulesetId: null });
}

export async function removeAdChannel(channelId: string) {
  adChannels.delete(channelId);
  await db.adChannel.delete({ where: { channelId } }).catch(() => {});
}

// ---- Rulesets ----

export const listRulesets = (guildId: string) => [...rulesets.values()].filter((r) => r.guildId === guildId).sort((a, b) => a.name.localeCompare(b.name));
export const getRuleset = (id: string) => rulesets.get(id);
export const findRuleset = (guildId: string, nameOrId: string) =>
  rulesets.get(nameOrId)?.guildId === guildId ? rulesets.get(nameOrId) : listRulesets(guildId).find((r) => r.name.toLowerCase() === nameOrId.toLowerCase());
export const channelsUsingRuleset = (id: string) => [...adChannels.entries()].filter(([, v]) => v.rulesetId === id).map(([c]) => c);

export async function createRuleset(guildId: string, name: string, rules: ChannelRules) {
  const row = await db.ruleSet.create({ data: { guildId, name, rules: JSON.stringify(rules) } });
  const entry = { id: row.id, guildId, name, rules };
  rulesets.set(row.id, entry);
  return entry;
}

export async function saveRuleset(id: string, rules: ChannelRules) {
  await db.ruleSet.update({ where: { id }, data: { rules: JSON.stringify(rules) } });
  const rs = rulesets.get(id);
  if (rs) rs.rules = rules;
}

export async function renameRuleset(id: string, name: string) {
  await db.ruleSet.update({ where: { id }, data: { name } });
  const rs = rulesets.get(id);
  if (rs) rs.name = name;
}

/** Deletes a ruleset; linked channels keep a copy of its rules as their own. */
export async function deleteRuleset(id: string) {
  const rs = rulesets.get(id);
  if (!rs) return 0;
  const linked = channelsUsingRuleset(id);
  for (const c of linked) await setAdChannel(rs.guildId, c, rs.rules);
  await db.ruleSet.delete({ where: { id } });
  rulesets.delete(id);
  return linked.length;
}

export async function linkChannel(guildId: string, channelId: string, rulesetId: string | null) {
  const own = adChannels.get(channelId)?.rules ?? (rulesetId ? rulesets.get(rulesetId)!.rules : parseRules({}));
  await db.adChannel.upsert({
    where: { channelId },
    create: { channelId, guildId, rules: JSON.stringify(own), rulesetId },
    update: { rulesetId },
  });
  adChannels.set(channelId, { guildId, rules: own, rulesetId });
}

/** Saves rules to wherever a channel gets them from (its ruleset, or itself). */
export async function saveRulesForChannel(guildId: string, channelId: string, rules: ChannelRules) {
  const ch = adChannels.get(channelId);
  if (ch?.rulesetId && rulesets.has(ch.rulesetId)) return saveRuleset(ch.rulesetId, rules);
  return setAdChannel(guildId, channelId, rules);
}

export async function adjustReputation(guildId: string, userId: string, kind: "clean" | "violation") {
  const delta = kind === "clean" ? 1 : -2;
  return db.reputation.upsert({
    where: { guildId_userId: { guildId, userId } },
    create: { guildId, userId, score: delta, clean: kind === "clean" ? 1 : 0, violations: kind === "violation" ? 1 : 0 },
    update: {
      score: { increment: delta },
      ...(kind === "clean" ? { clean: { increment: 1 } } : { violations: { increment: 1 } }),
    },
  });
}

export async function getReputation(guildId: string, userId: string) {
  return (
    (await db.reputation.findUnique({ where: { guildId_userId: { guildId, userId } } })) ?? {
      guildId,
      userId,
      score: 0,
      clean: 0,
      violations: 0,
    }
  );
}

export async function recordAd(data: {
  messageId: string;
  channelId: string;
  guildId: string;
  authorId: string;
  inviteCode?: string;
  targetGuildId?: string;
  targetName?: string;
  expiryDays: number;
}) {
  const { expiryDays, ...rest } = data;
  return db.ad.upsert({
    where: { messageId: data.messageId },
    create: { ...rest, expiresAt: expiryDays ? new Date(Date.now() + expiryDays * 86_400_000) : null },
    update: {},
  });
}

export async function markAdRemoved(messageId: string, reason: string, status: "removed" | "expired" = "removed") {
  await db.ad.updateMany({ where: { messageId, status: "live" }, data: { status, removedReason: reason } });
}
