// The cron grammar: crontab(5)'s five fields, minute hour day month weekday,
// where in the text they count, the values each one allows, and the
// wall-clock minutes an expression matches.

import { stripJoin } from "./interval.ts";
import type { Result } from "./types.ts";

const MINUTE_MS = 60_000;

/** A cron expression: the values each of its five fields allows, and its text. */
export interface Cron {
  /** The five fields as typed, joined by one space: what loops.json, the roster, and the panel show. */
  text: string;
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  /** 0 is Sunday; a 7 in the expression is stored as 0. */
  weekdays: ReadonlySet<number>;
  /** Both day fields are restricted, neither starting with *, so a day matching either one counts; otherwise a day must match both. */
  eitherDay: boolean;
}

interface Field {
  label: string;
  min: number;
  max: number;
  /** Three-letter names in value order, the first naming `min`. */
  names?: readonly string[];
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MINUTE: Field = { label: "minute", min: 0, max: 59 };
const HOUR: Field = { label: "hour", min: 0, max: 23 };
const DAY: Field = { label: "day", min: 1, max: 31 };
const MONTH: Field = { label: "month", min: 1, max: 12, names: MONTHS };
const WEEKDAY: Field = { label: "weekday", min: 0, max: 7, names: WEEKDAYS };

/** The most days each month has, February in a leap year. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

// What a token at the head of the text must look like to be read as a cron field: digits and * , - /,
// with three-letter month names in the fourth position and weekday names in the fifth.
const CHARS = "[\\d*,/-]";
const NUMBERS = new RegExp(`^${CHARS}+$`);
const SHAPES = [
  NUMBERS,
  NUMBERS,
  NUMBERS,
  new RegExp(`^(?:${CHARS}|${MONTHS.join("|")})+$`, "i"),
  new RegExp(`^(?:${CHARS}|${WEEKDAYS.join("|")})+$`, "i"),
];
/** A token that could be a cron field of either kind. */
const FIELDISH = new RegExp(`^(?:${CHARS}|${[...MONTHS, ...WEEKDAYS].join("|")})+$`, "i");
/** Punctuation that may close the fifth field, as after a head interval phrase. */
const CLOSING = /[,;:.!]+$/;

/**
 * The cron expression at the head of the text and the text after it, with
 * punctuation closing the fifth field and a leading and/then dropped.
 * Undefined when the first five tokens are not all shaped like cron fields;
 * an error when they are but do not parse, or when a sixth token right after
 * them is shaped like a field too, as a seconds or year field would be.
 */
export function parseCronHead(text: string): Result<{ cron: Cron; rest: string }> | undefined {
  const tokens = [...text.matchAll(/\S+/g)];
  const last = tokens[4];
  if (last === undefined) return undefined;
  const fifth = last[0].replace(CLOSING, "");
  const fields = [...tokens.slice(0, 4).map((t) => t[0]), fifth];
  if (!fields.every((field, i) => SHAPES[i]?.test(field))) return undefined;
  const cron = parseCron(fields.join(" "));
  if (!cron.ok) return cron;
  const sixth = tokens[5]?.[0];
  const closed = fifth !== last[0];
  if (!closed && sixth !== undefined && FIELDISH.test(sixth) && /[\d*a-z]/i.test(sixth)) {
    return { ok: false, error: `cron takes five fields (minute hour day month weekday); "${sixth}" would be a sixth` };
  }
  return { ok: true, value: { cron: cron.value, rest: stripJoin("", text.slice(last.index + last[0].length)) } };
}

export function parseCron(text: string): Result<Cron> {
  const tokens = fiveFields(text);
  if (!tokens) return { ok: false, error: `cron "${text}" needs five fields: minute hour day month weekday` };
  const [minute, hour, day, month, weekday] = tokens;
  const minutes = parseField(minute, MINUTE);
  if (!minutes.ok) return minutes;
  const hours = parseField(hour, HOUR);
  if (!hours.ok) return hours;
  const days = parseField(day, DAY);
  if (!days.ok) return days;
  const months = parseField(month, MONTH);
  if (!months.ok) return months;
  const weekdays = parseField(weekday, WEEKDAY);
  if (!weekdays.ok) return weekdays;
  const cron: Cron = {
    text: tokens.join(" "),
    minutes: minutes.value,
    hours: hours.value,
    days: days.value,
    months: months.value,
    weekdays: weekdays.value,
    eitherDay: !day.startsWith("*") && !weekday.startsWith("*"),
  };
  // With either day counting, every allowed month has an allowed weekday. Otherwise some allowed month
  // needs an allowed day it has; given one, the 400-year calendar cycle puts it on every weekday.
  const someDay = [...cron.months].some((m) => [...cron.days].some((d) => d <= (MONTH_DAYS[m - 1] ?? 0)));
  if (!cron.eitherDay && !someDay) return { ok: false, error: `cron "${cron.text}" never matches` };
  return { ok: true, value: cron };
}

/** The text's five whitespace-separated fields, or undefined when it has another number. */
function fiveFields(text: string): [string, string, string, string, string] | undefined {
  const [a, b, c, d, e, ...rest] = text.trim().split(/\s+/);
  if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || rest.length > 0) return undefined;
  return [a, b, c, d, e];
}

/** One field: a comma-separated list of `*`, a value, or a range, each `*` and range with an optional `/step`. */
function parseField(token: string, field: Field): Result<Set<number>> {
  const takes = `${field.min}-${field.max}${field.names ? ` or ${field.names[0]}-${field.names.at(-1)}` : ""}`;
  const bad = (why = `not a value ${takes}, *, a range, a list, or a step`): Result<Set<number>> => ({
    ok: false,
    error: `bad cron ${field.label} "${token}": ${why}`,
  });
  const values = new Set<number>();
  for (const item of token.split(",")) {
    const [base = "", stepText, extra] = item.split("/");
    if (extra !== undefined || (stepText !== undefined && !/^\d+$/.test(stepText))) return bad();
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) return bad("step must be at least 1");
    let lo = field.min;
    let hi = field.max;
    if (base !== "*") {
      const [from = "", to, more] = base.split("-");
      if (more !== undefined) return bad();
      const start = value(from, field);
      let end = to === undefined ? start : value(to, field);
      if (start === "bad" || end === "bad") return bad();
      if (start === "range" || end === "range") return bad(`out of range ${field.min}-${field.max}`);
      if (to === undefined && stepText !== undefined) return bad("a step follows * or a range, as in */15");
      // `sun` closing a range that starts on another day is the 7 that ends the week: fri-sun.
      if (field === WEEKDAY && end === 0 && start > 0 && to?.toLowerCase() === "sun") end = 7;
      if (start > end) return bad("range runs backwards");
      lo = start;
      hi = end;
    }
    // 7 is Sunday as well as 0.
    for (let v = lo; v <= hi; v += step) values.add(field === WEEKDAY && v === 7 ? 0 : v);
  }
  return { ok: true, value: values };
}

/** A number or a name in the field's range. */
function value(text: string, field: Field): number | "bad" | "range" {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n < field.min || n > field.max ? "range" : n;
  }
  const at = field.names?.indexOf(text.toLowerCase()) ?? -1;
  return at < 0 ? "bad" : field.min + at;
}

/** No match this many years ahead means none ever: the Gregorian calendar repeats every 400 years. */
const SEARCH_YEARS = 400;

/**
 * The first whole minute at or after `wall` that the expression matches.
 * `wall` is milliseconds from 1970-01-01 00:00 on the clock the expression
 * reads, taken as if that clock were UTC; so is the result. A month, day, or
 * hour that cannot match is skipped whole.
 */
export function nextCronWall(cron: Cron, wall: number): number {
  const start = new Date(Math.ceil(wall / MINUTE_MS) * MINUTE_MS);
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth() + 1;
  let day = start.getUTCDate();
  let hour = start.getUTCHours();
  let minute = start.getUTCMinutes();
  const last = year + SEARCH_YEARS;
  while (year <= last) {
    if (!cron.months.has(month) || day > daysIn(year, month)) {
      [year, month, day, hour, minute] = month === 12 ? [year + 1, 1, 1, 0, 0] : [year, month + 1, 1, 0, 0];
    } else if (!dayMatches(cron, year, month, day)) {
      [day, hour, minute] = [day + 1, 0, 0];
    } else if (!cron.hours.has(hour)) {
      [day, hour, minute] = hour === 23 ? [day + 1, 0, 0] : [day, hour + 1, 0];
    } else if (!cron.minutes.has(minute)) {
      if (minute < 59) minute += 1;
      else [day, hour, minute] = hour === 23 ? [day + 1, 0, 0] : [day, hour + 1, 0];
    } else {
      return Date.UTC(year, month - 1, day, hour, minute);
    }
  }
  throw new Error(`cron "${cron.text}" matches no minute in ${SEARCH_YEARS} years`);
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Whether a date passes the day fields: either one when both are restricted, both otherwise. */
function dayMatches(cron: Cron, year: number, month: number, day: number): boolean {
  const byDay = cron.days.has(day);
  const byWeekday = cron.weekdays.has(new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  return cron.eitherDay ? byDay || byWeekday : byDay && byWeekday;
}
