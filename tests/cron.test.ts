// The cron grammar of docs/specs/pi-loop-cron.md AC-C2 and AC-C3: what each field allows, the day rule, and what rejects.

import { describe, expect, test } from "bun:test";
import { parseCron } from "../extensions/pi-loop/cron.ts";

const sorted = (values: ReadonlySet<number>) => [...values].sort((a, b) => a - b);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The parsed fields as sorted lists, or the error text. */
function parse(text: string) {
  const parsed = parseCron(text);
  if (!parsed.ok) return parsed.error;
  const c = parsed.value;
  return {
    text: c.text,
    minutes: sorted(c.minutes),
    hours: sorted(c.hours),
    days: sorted(c.days),
    months: sorted(c.months),
    weekdays: sorted(c.weekdays),
    eitherDay: c.eitherDay,
  };
}

describe("AC-C2 the five fields", () => {
  test("lists, ranges, steps, and names, each field to the values it allows", () => {
    expect(parse("*/15 9-17 1,15 jan-mar,jul mon-fri")).toEqual({
      text: "*/15 9-17 1,15 jan-mar,jul mon-fri",
      minutes: [0, 15, 30, 45],
      hours: range(9, 17),
      days: [1, 15],
      months: [1, 2, 3, 7],
      weekdays: [1, 2, 3, 4, 5],
      eitherDay: true,
    });
  });

  test("* is the whole field: minute 0-59, hour 0-23, day 1-31, month 1-12, weekday 0-6", () => {
    expect(parse("* * * * *")).toEqual({
      text: "* * * * *",
      minutes: range(0, 59),
      hours: range(0, 23),
      days: range(1, 31),
      months: range(1, 12),
      weekdays: range(0, 6),
      eitherDay: false,
    });
  });

  test("steps run from the start of their range; a step wider than the range keeps its start", () => {
    const one = (text: string) => {
      const p = parse(text);
      return typeof p === "string" ? p : [p.minutes, p.hours, p.days];
    };
    expect(one("0-30/10 */7 1-5/2 * *")).toEqual([[0, 10, 20, 30], [0, 7, 14, 21], [1, 3, 5]]);
    expect(one("*/90 3-4/5 */10 * *")).toEqual([[0], [3], [1, 11, 21, 31]]);
    expect(one("05,7 08 09 * *")).toEqual([[5, 7], [8], [9]]);
  });

  test("0 and 7 are both Sunday, sun ends a range as 7, and names match in any case", () => {
    const weekdays = (text: string) => {
      const p = parse(`0 0 * * ${text}`);
      return typeof p === "string" ? p : p.weekdays;
    };
    expect(weekdays("7")).toEqual([0]);
    expect(weekdays("0")).toEqual([0]);
    expect(weekdays("5-7")).toEqual([0, 5, 6]);
    expect(weekdays("fri-sun")).toEqual([0, 5, 6]);
    expect(weekdays("sun-sun")).toEqual([0]);
    expect(weekdays("sun-tue")).toEqual([0, 1, 2]);
    expect(weekdays("SUN,Wed,sat")).toEqual([0, 3, 6]);
    expect(weekdays("*/2")).toEqual([0, 2, 4, 6]);
    const months = parse("0 0 * JAN,Jul-sep,dec *");
    expect(typeof months === "string" ? months : months.months).toEqual([1, 7, 8, 9, 12]);
  });

  test("a day field is restricted unless it starts with *; only both restricted makes either day count", () => {
    const either = (text: string) => {
      const p = parse(text);
      return typeof p === "string" ? p : p.eitherDay;
    };
    expect(either("30 4 1,15 * 5")).toBe(true);
    expect(either("0 9 * * 1-5")).toBe(false);
    expect(either("0 9 1 * *")).toBe(false);
    expect(either("0 9 */2 * 1")).toBe(false);
    expect(either("0 9 1 * */2")).toBe(false);
    expect(either("0 9 1-31 * 0-6")).toBe(true);
  });

  test("the text is the five fields as typed, joined by one space", () => {
    const p = parse("  0\t9  *   * MON-fri ");
    expect(typeof p === "string" ? p : p.text).toBe("0 9 * * MON-fri");
  });
});

describe("AC-C3 what rejects", () => {
  test("a field that is not a list of items says what the field takes", () => {
    const minute = (token: string) => `bad cron minute "${token}": not a value 0-59, *, a range, a list, or a step`;
    expect(parse("0 9 * * 1-")).toBe('bad cron weekday "1-": not a value 0-7 or sun-sat, *, a range, a list, or a step');
    expect(parse("1,,2 * * * *")).toBe(minute("1,,2"));
    expect(parse("*-5 * * * *")).toBe(minute("*-5"));
    expect(parse("*/5/2 * * * *")).toBe(minute("*/5/2"));
    expect(parse("*/x * * * *")).toBe(minute("*/x"));
    expect(parse("x/5 * * * *")).toBe(minute("x/5"));
    expect(parse("0 mon * * *")).toBe('bad cron hour "mon": not a value 0-23, *, a range, a list, or a step');
    expect(parse("0 0 * mon *")).toBe('bad cron month "mon": not a value 1-12 or jan-dec, *, a range, a list, or a step');
    expect(parse("0 0 * * jan")).toBe('bad cron weekday "jan": not a value 0-7 or sun-sat, *, a range, a list, or a step');
    expect(parse("0 0 L * *")).toBe('bad cron day "L": not a value 1-31, *, a range, a list, or a step');
    expect(parse("0 0 ? * 1")).toBe('bad cron day "?": not a value 1-31, *, a range, a list, or a step');
  });

  test("a value outside its field's range", () => {
    expect(parse("60 * * * *")).toBe('bad cron minute "60": out of range 0-59');
    expect(parse("0 25 * * *")).toBe('bad cron hour "25": out of range 0-23');
    expect(parse("0 0 0 * *")).toBe('bad cron day "0": out of range 1-31');
    expect(parse("0 0 32 * *")).toBe('bad cron day "32": out of range 1-31');
    expect(parse("0 0 * 13 *")).toBe('bad cron month "13": out of range 1-12');
    expect(parse("0 0 * * 8")).toBe('bad cron weekday "8": out of range 0-7');
    expect(parse("0 0 * * 1,99999999999999999999")).toBe('bad cron weekday "1,99999999999999999999": out of range 0-7');
  });

  test("a range that runs backwards", () => {
    expect(parse("0 17-9 * * *")).toBe('bad cron hour "17-9": range runs backwards');
    expect(parse("0 0 * dec-jan *")).toBe('bad cron month "dec-jan": range runs backwards');
    expect(parse("0 0 * * sat-mon")).toBe('bad cron weekday "sat-mon": range runs backwards');
  });

  test("a step of 0, or a step after a single value", () => {
    expect(parse("*/0 * * * *")).toBe('bad cron minute "*/0": step must be at least 1');
    expect(parse("0-30/0 * * * *")).toBe('bad cron minute "0-30/0": step must be at least 1');
    expect(parse("5/15 * * * *")).toBe('bad cron minute "5/15": a step follows * or a range, as in */15');
  });

  test("an expression no date matches, because no allowed month has an allowed day of month", () => {
    expect(parse("0 0 30 2 *")).toBe('cron "0 0 30 2 *" never matches');
    expect(parse("0 0 31 4,6,9,11 *")).toBe('cron "0 0 31 4,6,9,11 *" never matches');
    expect(parse("0 0 31 apr-jun/2 */3")).toBe('cron "0 0 31 apr-jun/2 */3" never matches');
    // A leap day, a 31st some month has, and a weekday the either rule adds all match some date.
    expect(typeof parse("0 0 29 2 *")).toBe("object");
    expect(typeof parse("0 0 31 * *")).toBe("object");
    expect(typeof parse("0 0 30 2 1")).toBe("object");
  });

  test("anything but five fields", () => {
    expect(parse("0 9 * *")).toBe('cron "0 9 * *" needs five fields: minute hour day month weekday');
    expect(parse("0 0 9 * * 1")).toBe('cron "0 0 9 * * 1" needs five fields: minute hour day month weekday');
    expect(parse("")).toBe('cron "" needs five fields: minute hour day month weekday');
  });
});
