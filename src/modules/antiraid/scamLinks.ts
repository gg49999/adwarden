import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { env } from "../../env.js";
import { log } from "../../logger.js";

const domains = new Set<string>();

function addAll(list: string[]) {
  for (const d of list) {
    const clean = d.trim().toLowerCase().replace(/^www\./, "");
    if (clean && !clean.startsWith("#")) domains.add(clean);
  }
}

/** Loads data/scam-domains.txt plus the optional remote list in SCAM_LIST_URL. */
export async function loadScamDomains() {
  domains.clear();
  const local = resolve(process.cwd(), "data", "scam-domains.txt");
  if (existsSync(local)) addAll(readFileSync(local, "utf8").split(/\r?\n/));
  if (env.scamListUrl) {
    try {
      const res = await fetch(env.scamListUrl, { signal: AbortSignal.timeout(10_000) });
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        addAll(Array.isArray(json) ? json : Array.isArray(json.domains) ? json.domains : []);
      } catch {
        addAll(text.split(/\r?\n/));
      }
    } catch (err) {
      log.warn("Couldn't download the scam domain list", err instanceof Error ? err.message : err);
    }
  }
  log.info(`Loaded ${domains.size} scam domain(s)`);
}

export function isScamHost(host: string): boolean {
  if (!host) return false;
  if (domains.has(host)) return true;
  // check parent domains: a.b.example.com -> b.example.com -> example.com
  const parts = host.split(".");
  for (let n = 1; n < parts.length - 1; n++) if (domains.has(parts.slice(n).join("."))) return true;
  return false;
}

/** Look-alike check for the most abused brands, catches domains not on any list yet. */
const LOOKALIKE = /(d[il1]sc[o0]r[dcl]|disc[o0]rd|dlscord|discrod|disocrd)[-.]?(gift|nitro|app|give|promo|drop)s?\.|steam(c[o0]mmunity|powered)?[-.]?(gift|trade|promo)|(nitro|steam)[-.]?(free|gift|drop)/i;
const REAL = new Set(["discord.com", "discord.gg", "discordapp.com", "discord.gift", "discord.media", "discordapp.net", "steamcommunity.com", "steampowered.com", "discord.new", "discord.dev"]);

export function looksLikeScam(host: string): boolean {
  if (REAL.has(host) || [...REAL].some((r) => host.endsWith("." + r))) return false;
  return LOOKALIKE.test(host + ".");
}
