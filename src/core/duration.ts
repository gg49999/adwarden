const UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** Parses "90s", "10m", "2h", "7d", "1w", or combos like "1d12h". Returns ms, or null if invalid. */
export function parseDuration(input: string): number | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, "");
  if (!s) return null;
  const re = /(\d+)(s|m|h|d|w)/g;
  let total = 0;
  let consumed = 0;
  for (const m of s.matchAll(re)) {
    total += Number(m[1]) * UNITS[m[2]];
    consumed += m[0].length;
  }
  if (consumed !== s.length || total <= 0) return null;
  return total;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let rest = Math.round(ms / 1000);
  for (const [label, secs] of [["d", 86400], ["h", 3600], ["m", 60], ["s", 1]] as const) {
    const n = Math.floor(rest / secs);
    if (n) {
      parts.push(`${n}${label}`);
      rest -= n * secs;
    }
  }
  return parts.slice(0, 2).join(" ") || "0s";
}

/** Discord timeouts are capped at 28 days. */
export const MAX_TIMEOUT_MS = 28 * 86_400_000;
