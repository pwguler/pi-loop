// /loop argument parsing: subcommands, flags at the head or the tail, the
// interval phrase or the cron expression at the head, and what is left as the
// prompt. The loop tool's parameters become the same commands.

import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { parseCronHead } from "./cron.ts";
import { countedIntervals, parseIntervalPhrase } from "./interval.ts";
import { NAME_PATTERN, type Loop, type PromptSource, type Result, type Schedule } from "./types.ts";

export type Command =
  | { kind: "list" }
  | { kind: "stop" | "pause" | "resume"; name: string }
  | { kind: "create"; schedule: Schedule; prompt: PromptSource; name?: string; max?: number; until?: number };

interface Flags {
  name?: string;
  max?: number;
  until?: number;
}

const USAGE =
  "usage: /loop [--name <n>] [--max <n>] [--until <ISO|HH:mm>] <prompt with an interval: 5m, every 2 hours, hourly, daily | @file>, or /loop [flags] <cron: 0 9 * * 1-5> <prompt | @file>";

export function parseCommand(args: string, now: number): Result<Command> {
  const [head, rest] = nextToken(args);
  if (head === "" || head === "list") return { ok: true, value: { kind: "list" } };
  if (head === "stop" || head === "pause" || head === "resume") {
    const [name, extra] = nextToken(rest);
    if (name === "" || extra.trim() !== "") return { ok: false, error: `usage: /loop ${head} <name>` };
    return { ok: true, value: { kind: head, name } };
  }

  // Flags sit at the head or the tail, before or after the interval phrase or cron expression; never inside the prompt.
  // Tail flags go before either is looked for, so a flag value is never taken for one.
  const flags: Flags = {};
  const lead = stripFlags(args, flags, now);
  if (!lead.ok) return lead;
  const tail = stripTailFlags(lead.value, flags, now);
  if (!tail.ok) return tail;
  const schedule = parseSchedule(tail.value);
  if (!schedule.ok) return schedule;
  const second = stripFlags(schedule.value.rest, flags, now);
  if (!second.ok) return second;
  const third = stripTailFlags(second.value, flags, now);
  if (!third.ok) return third;

  const prompt = promptSource(third.value);
  if (!prompt.ok) return prompt;
  return {
    ok: true,
    value: { kind: "create", schedule: schedule.value.schedule, prompt: prompt.value, name: flags.name, max: flags.max, until: flags.until },
  };
}

/** A prompt that is one @<path> token is a file re-read at every fire; anything else is text. */
function promptSource(text: string): Result<PromptSource> {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: `missing prompt. ${USAGE}` };
  return { ok: true, value: /^@\S+$/.test(trimmed) ? { kind: "file", path: trimmed.slice(1) } : { kind: "text", text: trimmed } };
}

export const LOOP_TOOL_PARAMETERS = Type.Object({
  action: StringEnum(["create", "list", "pause", "resume", "stop"] as const),
  name: Type.Optional(Type.String({ description: "The loop's name. Required for pause, resume, and stop. Optional for create: letters, digits, . _ - only; omitted, a name is chosen." })),
  schedule: Type.Optional(
    Type.String({ description: "create only. Either an interval phrase alone (5m, every 30 minutes, 1h30m, hourly, daily; at least 1m) or five cron fields alone (0 9 * * 1-5), on the local clock." }),
  ),
  prompt: Type.Optional(Type.String({ description: "create only. The text sent at every fire, stored as given; or @<path> as one token with no spaces to re-read that file at every fire." })),
  // No schema minimum: pi would reject 0 with its own text before toolCommand returns /loop's error.
  max: Type.Optional(Type.Integer({ description: "create only. Remove the loop after this many fires." })),
  until: Type.Optional(Type.String({ description: "create only. Remove the loop at this time: an ISO datetime, or HH:mm for the next such local time." })),
});

export type LoopToolParams = Static<typeof LOOP_TOOL_PARAMETERS>;

/** The loop tool's parameters as the command /loop would parse; the schedule must be one interval phrase or one cron expression and nothing else. */
export function toolCommand(params: LoopToolParams, now: number): Result<Command> {
  const { action } = params;
  if (action === "list") return { ok: true, value: { kind: "list" } };
  if (action !== "create") {
    if (params.name === undefined || params.name.trim() === "") return { ok: false, error: `${action} needs the loop's name` };
    return { ok: true, value: { kind: action, name: params.name.trim() } };
  }
  const flags: Flags = {};
  const given: Array<[string, string | undefined]> = [
    ["--name", params.name?.trim() || undefined],
    ["--max", params.max?.toString()],
    ["--until", params.until],
  ];
  for (const [flag, value] of given) {
    if (value === undefined) continue;
    const applied = applyFlag(flag, value, flags, now);
    if (!applied.ok) return applied;
  }
  const text = params.schedule ?? "";
  const schedule = parseSchedule(text);
  if (!schedule.ok) return schedule;
  if (schedule.value.rest.trim() !== "") {
    return { ok: false, error: `schedule "${text}" holds more than an interval phrase or a cron expression; put the rest in prompt` };
  }
  const prompt = promptSource(params.prompt ?? "");
  if (!prompt.ok) return prompt;
  return { ok: true, value: { kind: "create", schedule: schedule.value.schedule, prompt: prompt.value, ...flags } };
}

/**
 * The loop's schedule, from the cron expression at the head or else from the
 * one interval phrase that counts, and the text left once that is cut out. A
 * cron expression beside an interval phrase that counts rejects.
 */
function parseSchedule(text: string): Result<{ schedule: Schedule; rest: string }> {
  const head = parseCronHead(text);
  if (head === undefined) {
    const interval = parseIntervalPhrase(text);
    if (interval === undefined) {
      return {
        ok: false,
        error: "no interval or cron expression found: say 5m, every 2 hours, hourly, or daily, or start with five cron fields like 0 9 * * 1-5",
      };
    }
    if (!interval.ok) return interval;
    return { ok: true, value: { schedule: { intervalMs: interval.value.ms }, rest: interval.value.rest } };
  }
  if (!head.ok) return head;
  const [phrase] = countedIntervals(text);
  if (phrase) return { ok: false, error: `a cron expression and an interval: "${head.value.cron.text}" and "${phrase.text}"; say one` };
  return { ok: true, value: { schedule: { cron: head.value.cron }, rest: head.value.rest } };
}

/** Consume leading --flag value pairs into flags; returns the remaining text. */
function stripFlags(text: string, flags: Flags, now: number): Result<string> {
  let remainder = text;
  while (remainder.trimStart().startsWith("--")) {
    const [flag, afterFlag] = nextToken(remainder);
    const [value, afterValue] = nextToken(afterFlag);
    if (value === "") return { ok: false, error: `${flag} needs a value. ${USAGE}` };
    const applied = applyFlag(flag, value, flags, now);
    if (!applied.ok) return applied;
    remainder = afterValue;
  }
  return { ok: true, value: remainder };
}

/** Consume trailing --flag value pairs into flags; returns the remaining text. */
function stripTailFlags(text: string, flags: Flags, now: number): Result<string> {
  let remainder = text;
  for (;;) {
    const m = /(?:^|\s)(--\S+)\s+(\S+)\s*$/.exec(remainder);
    if (!m || m[1] === undefined || m[2] === undefined) return { ok: true, value: remainder };
    const applied = applyFlag(m[1], m[2], flags, now);
    if (!applied.ok) return applied;
    remainder = remainder.slice(0, m.index);
  }
}

function applyFlag(flag: string, value: string, flags: Flags, now: number): Result<void> {
  if (flag === "--name") {
    if (!NAME_PATTERN.test(value)) return { ok: false, error: `bad name "${value}": letters, digits, . _ - only` };
    flags.name = value;
  } else if (flag === "--max") {
    if (!/^[1-9]\d*$/.test(value)) return { ok: false, error: `bad --max "${value}": positive integer` };
    flags.max = Number(value);
  } else if (flag === "--until") {
    const parsed = parseUntil(value, now);
    if (!parsed.ok) return parsed;
    flags.until = parsed.value;
  } else {
    return { ok: false, error: `unknown flag ${flag}. ${USAGE}` };
  }
  return { ok: true, value: undefined };
}

/** Split off the first whitespace-delimited token; returns [token, rest]. */
function nextToken(input: string): [string, string] {
  const s = input.trimStart();
  const end = s.search(/\s/);
  if (end === -1) return [s, ""];
  return [s.slice(0, end), s.slice(end)];
}

function parseUntil(value: string, now: number): Result<number> {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(value);
  let at: number;
  if (hm) {
    const h = Number(hm[1]);
    const mm = Number(hm[2]);
    if (h > 23 || mm > 59) return { ok: false, error: `bad --until "${value}": HH:mm out of range` };
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    at = d.getTime();
  } else {
    at = Date.parse(value);
    if (Number.isNaN(at)) return { ok: false, error: `bad --until "${value}": use an ISO datetime or HH:mm` };
  }
  if (at <= now) return { ok: false, error: `--until ${value} is already in the past; give a later time` };
  return { ok: true, value: at };
}

/** loop-<k> with the lowest free k. */
export function defaultName(loops: Loop[]): string {
  const taken = new Set(loops.map((l) => l.name));
  let k = 1;
  while (taken.has(`loop-${k}`)) k++;
  return `loop-${k}`;
}
