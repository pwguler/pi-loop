// The interval phrase grammar: how "5m", "every 2 hours", "hourly", "1h30m"
// become milliseconds, and where in the text a phrase is allowed to sit.

import type { Result } from "./types.ts";

export const MIN_INTERVAL_MS = 60_000;

// Interval grammar. A phrase is an optional every/each, then either a bare
// unit word (hourly, hour, day, ...) or one or more <n><unit> pairs (5m, 5 min,
// 2 hours, 1h30m, 1 hour 30 minutes).
const UNIT = "(?:minutes|minute|mins|min|m|hours|hour|hrs|hr|h|days|day|d)";
const BARE_UNIT = "(?:hourly|daily|minute|hour|day)";
// After a unit: end, a non-word character, or a digit starting the next pair (1h30m).
const AFTER_UNIT = "(?=$|\\W|\\d)";
const NUMBER_UNIT = new RegExp(`(\\d+)\\s*${UNIT}${AFTER_UNIT}`, "g");
const PHRASE = new RegExp(
  `(?:(every|each)\\s+)?(?:${BARE_UNIT}\\b|\\d+\\s*${UNIT}${AFTER_UNIT}(?:\\s*\\d+\\s*${UNIT}${AFTER_UNIT})*)`,
  "gi",
);
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  hourly: 3_600_000,
  daily: 86_400_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
};

interface IntervalCandidate {
  text: string;
  ms: number;
  start: number;
  end: number;
  prefixed: boolean;
}

/** Every interval phrase in the text, in order, with its position. */
export function intervals(text: string): IntervalCandidate[] {
  const found: IntervalCandidate[] = [];
  for (const m of text.matchAll(PHRASE)) {
    const start = m.index;
    // A phrase starts at a word boundary: "every5m" and "x5m" are not phrases.
    if (start > 0 && /\w/.test(text.charAt(start - 1))) continue;
    const prefixed = m[1] !== undefined;
    const body = prefixed ? m[0].replace(/^(?:every|each)\s+/i, "") : m[0];
    const bare = UNIT_MS[body.toLowerCase()];
    let ms = 0;
    if (bare !== undefined) {
      ms = bare;
    } else {
      for (const pair of body.matchAll(NUMBER_UNIT)) {
        const unit = pair[0].replace(/^\d+\s*/, "").charAt(0).toLowerCase();
        ms += Number(pair[1]) * (UNIT_MS[unit] ?? 0);
      }
    }
    found.push({ text: m[0], ms, start, end: start + m[0].length, prefixed });
  }
  return found;
}

/**
 * Pick the one interval phrase in the text and cut it out. At the head or the
 * tail any form counts; in the middle only an every/each phrase does, so a
 * duration inside the instruction is never eaten. Two phrases reject.
 */
export function parseIntervalPhrase(input: string): Result<{ ms: number; rest: string }> {
  const text = input.trim();
  const tailEnd = text.replace(/[\s.,;:!]+$/, "").length;
  const candidates = intervals(text).filter((c) => c.prefixed || c.start === 0 || c.end === tailEnd);
  const [one, two] = candidates;
  if (!one) return { ok: false, error: "no interval found: say 5m, every 2 hours, hourly, or daily" };
  if (two) return { ok: false, error: `more than one interval: "${one.text}" and "${two.text}"; say one` };
  if (one.ms < MIN_INTERVAL_MS) return { ok: false, error: `interval "${one.text}" is below the minimum 1m` };
  return { ok: true, value: { ms: one.ms, rest: stripJoin(text.slice(0, one.start), text.slice(one.end)) } };
}

/**
 * Join the text around a removed phrase. Punctuation that touched the phrase
 * goes; a dangling and/then before it goes; an and/then after it stays, since
 * it still joins what follows to what came before.
 */
function stripJoin(before: string, after: string): string {
  const pre = before.replace(/[\s,;:.!]+$/, "").replace(/\s+(?:and|then)$/i, "");
  const post = after.replace(/^[\s,;:.!]+/, "");
  return pre === "" ? post : post === "" ? pre : `${pre} ${post}`;
}

/** Milliseconds to the shortest exact form: 5m, 2h, 1d, 1h30m. */
export function formatInterval(ms: number): string {
  const parts: string[] = [];
  let left = ms;
  for (const [unit, size] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000]] as const) {
    const n = Math.floor(left / size);
    if (n > 0) parts.push(`${n}${unit}`);
    left -= n * size;
  }
  return parts.join("") || "0m";
}
