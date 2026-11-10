/**
 * Word matching shared by the server-wide word filter and the per-ruleset blockedWords rule.
 * Pure: no Discord or database access, see tests/wordfilter.test.ts.
 *
 * Entry syntax:
 *   word     whole word only ("ass" does not match "class")
 *   word*    starts with  ("scam*" matches "scammer")
 *   *word    ends with
 *   *word*   anywhere inside a word
 */

export interface MatchOptions {
  /** Treat 0→o, 1/!→i, 3→e, 4/@→a, 5/$→s, 7→t, 8→b, 9→g */
  leet: boolean;
  /** Catch spaced-out letters ("f r e e  n i t r o") and stretched letters ("freeeee") */
  spacing: boolean;
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "8": "b", "9": "g" };

function baseNormalize(text: string): string {
  return text
    .normalize("NFKD") // fullwidth / styled letters → plain, accents split off
    .replace(/\p{M}/gu, "") // drop accents
    .replace(/[​-‏⁠-⁤﻿­]/g, "") // zero-width
    .toLowerCase();
}

const SPACED_RUN = /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s._*\-~|]+){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu;
const squeeze = (s: string, keep: "$1" | "$1$1") => s.replace(/(\p{L})\1{2,}/gu, keep);

export interface Variants {
  /** Whole-text variants, searched with the entry's normal word boundaries */
  texts: string[];
  /** Spaced-out letter runs glued together ("a s c a m" → "ascam"); searched anywhere inside */
  runs: string[];
}

/** The text variants a word is searched in. */
export function variants(text: string, opts: MatchOptions): Variants {
  let t = baseNormalize(text);
  if (opts.leet) t = t.replace(/[0134@57$89!]/g, (c) => LEET[c] ?? c);
  const texts = [t];
  const runs: string[] = [];
  if (opts.spacing) {
    // "freeeee" → "free"/"freee": squeeze 3+ repeated letters down to 1 and to 2
    for (const v of [squeeze(t, "$1"), squeeze(t, "$1$1")]) if (!texts.includes(v)) texts.push(v);
    // "f r e e" / "f.r.e.e" → "free". Only runs of 3+ single characters, so normal text is untouched.
    // A run may include a neighbouring one-letter word ("is a s c a m" → "ascam"), so runs are
    // searched without word boundaries.
    for (const m of t.matchAll(SPACED_RUN)) {
      const glued = m[0].replace(/[\s._*\-~|]+/g, "");
      runs.push(glued, squeeze(glued, "$1"));
    }
  }
  return { texts, runs };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface CompiledWord {
  entry: string;
  re: RegExp;
  /** The bare word with spaces removed, for searching inside glued spaced-out runs */
  core: string;
}

/** Cleans a user-typed list ("a, b\nc") into normalized, de-duplicated entries. */
export function parseWordList(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const w = baseNormalize(part).trim().replace(/\s+/g, " ");
    if (w && w.replace(/\*/g, "").length >= 2 && w.length <= 60) seen.add(w);
  }
  return [...seen];
}

export function compileWords(entries: string[]): CompiledWord[] {
  const out: CompiledWord[] = [];
  for (const entry of entries) {
    const starts = entry.startsWith("*");
    const ends = entry.endsWith("*");
    const core = entry.replace(/^\*+|\*+$/g, "");
    if (!core) continue;
    const body = escape(core).replace(/ /g, "\\s+");
    const left = starts ? "" : "(?<![\\p{L}\\p{N}])";
    const right = ends ? "" : "(?![\\p{L}\\p{N}])";
    out.push({ entry, re: new RegExp(left + body + right, "u"), core: core.replace(/\s+/g, "") });
  }
  return out;
}

/** Returns the first filter entry found in the text, or null. */
export function findWord(text: string, words: CompiledWord[], opts: MatchOptions): string | null {
  if (!words.length || !text) return null;
  const { texts, runs } = variants(text, opts);
  for (const w of words) {
    if (texts.some((v) => w.re.test(v))) return w.entry;
    if (w.core.length >= 3 && runs.some((r) => r.includes(w.core))) return w.entry;
  }
  return null;
}

// Small cache so the same list isn't recompiled for every message
const cache = new Map<string, CompiledWord[]>();
export function compiledFor(key: string, entries: string[]): CompiledWord[] {
  const sig = key + "\u0000" + entries.join("\u0001");
  let c = cache.get(sig);
  if (!c) {
    c = compileWords(entries);
    cache.set(sig, c);
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return c;
}
