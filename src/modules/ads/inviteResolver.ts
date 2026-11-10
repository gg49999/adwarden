import { DiscordAPIError, RESTJSONErrorCodes } from "discord.js";
import { client } from "../../client.js";
import { log } from "../../logger.js";
import type { ResolvedInvite } from "./engine.js";
import { extractInviteCodes, extractLinks, SHORTENERS } from "./invites.js";

const VALID_TTL = 30 * 60_000;
const INVALID_TTL = 10 * 60_000;
const cache = new Map<string, { at: number; value: ResolvedInvite }>();

export async function resolveInvite(code: string, opts: { fresh?: boolean } = {}): Promise<ResolvedInvite> {
  const key = code.toLowerCase();
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < (hit.value.valid ? VALID_TTL : INVALID_TTL)) return hit.value;

  let value: ResolvedInvite;
  try {
    const inv = await client.fetchInvite(code);
    const g = inv.guild;
    value = {
      code: inv.code,
      valid: !!g,
      guildId: g?.id,
      guildName: g?.name,
      memberCount: inv.memberCount ?? undefined,
      nsfwLevel: g && "nsfwLevel" in g ? Number(g.nsfwLevel) : undefined,
      iconUrl: g?.iconURL({ size: 128 }) ?? null,
    };
  } catch (err) {
    if (err instanceof DiscordAPIError && err.code === RESTJSONErrorCodes.UnknownInvite) {
      value = { code, valid: false };
    } else {
      // Network/rate-limit problems: don't punish the user, treat as unknown-but-valid.
      log.warn(`Invite lookup failed for ${code}`, err instanceof Error ? err.message : err);
      return { code, valid: true };
    }
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 5000) cache.delete(cache.keys().next().value!);
  return value;
}

/** Follows up to 3 redirects of a shortener link. Returns the final URL or null. */
async function followRedirects(url: string): Promise<string | null> {
  let current = url;
  for (let hop = 0; hop < 3; hop++) {
    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(4000),
        headers: { "user-agent": "AdwardenBot (link checker)" },
      });
      const loc = res.headers.get("location");
      res.body?.cancel().catch(() => {});
      if (!loc || res.status < 300 || res.status >= 400) return hop === 0 ? null : current;
      current = new URL(loc, current).toString();
    } catch {
      return hop === 0 ? null : current;
    }
  }
  return current;
}

export interface InviteScan {
  invites: ResolvedInvite[];
  resolvedShortenerUrls: string[];
}

/** Finds and resolves every invite in the text, including ones hidden behind shorteners. */
export async function scanInvites(content: string): Promise<InviteScan> {
  const codes = new Set(extractInviteCodes(content));
  const viaShortener = new Set<string>();
  const resolvedShortenerUrls: string[] = [];

  const shortLinks = extractLinks(content).filter((l) => SHORTENERS.has(l.host)).slice(0, 3);
  await Promise.all(
    shortLinks.map(async (l) => {
      const final = await followRedirects(l.url);
      if (!final) return;
      const found = extractInviteCodes(final);
      if (found.length) {
        resolvedShortenerUrls.push(l.url);
        for (const c of found) {
          codes.add(c);
          viaShortener.add(c);
        }
      }
    }),
  );

  const resolved = await Promise.all([...codes].slice(0, 5).map((c) => resolveInvite(c)));
  // Copy so the cached objects are never mutated
  const invites = resolved.map((inv) => (viaShortener.has(inv.code) ? { ...inv, viaShortener: true } : { ...inv }));
  return { invites, resolvedShortenerUrls };
}
