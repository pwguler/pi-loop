// The grid of docs/specs/pi-loop.md AC-16 and the cron points of docs/specs/pi-loop-cron.md AC-C4, on the local wall clock.

import { describe, expect, test } from "bun:test";
import { parseCron, type Cron } from "../extensions/pi-loop/cron.ts";
import { nextCronPoint, nextGridPoint } from "../extensions/pi-loop/schedule.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function local(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime();
}

/** A constant offset in minutes, positive west of UTC. */
const fixed = (minutes: number) => () => minutes;

/** An offset that moves by `delta` minutes at instant `at`. */
function shifting(base: number, delta: number, at: number): (t: number) => number {
  return (t) => (t < at ? base : base + delta);
}

/** Minutes west of UTC in an IANA zone from the zone's own rules, so a test does not depend on the process's TZ. Every real transition sits on a 15-minute boundary, so offsets are cached per 15 minutes. */
function zoneOffset(timeZone: string): (t: number) => number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const cache = new Map<number, number>();
  return (t) => {
    const bucket = Math.floor(t / (15 * MIN));
    const cached = cache.get(bucket);
    if (cached !== undefined) return cached;
    const parts = format.formatToParts(bucket * 15 * MIN);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const wall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    const minutes = (bucket * 15 * MIN - wall) / MIN;
    cache.set(bucket, minutes);
    return minutes;
  };
}

/** The next grid point found by testing every whole minute after `after`: slow, and right by construction. */
function walk(intervalMs: number, after: number, offset: (t: number) => number): number {
  for (let t = (Math.floor(after / MIN) + 1) * MIN; ; t += MIN) {
    if ((((t - offset(t) * MIN) % intervalMs) + intervalMs) % intervalMs === 0) return t;
  }
}

const utc = (iso: string): number => Date.parse(iso);

describe("nextGridPoint on the local clock", () => {
  test("5m at 10:07:23 is 10:10:00, and exactly on a point it is the next one", () => {
    expect(nextGridPoint(5 * MIN, local(2026, 9, 6, 10, 7, 23))).toBe(local(2026, 9, 6, 10, 10));
    expect(nextGridPoint(5 * MIN, local(2026, 9, 6, 10, 10))).toBe(local(2026, 9, 6, 10, 15));
  });

  test("15m marks :00 :15 :30 :45 and 1h marks HH:00", () => {
    expect(nextGridPoint(15 * MIN, local(2026, 9, 6, 10, 46))).toBe(local(2026, 9, 6, 11, 0));
    expect(nextGridPoint(15 * MIN, local(2026, 9, 6, 10, 16))).toBe(local(2026, 9, 6, 10, 30));
    expect(nextGridPoint(HOUR, local(2026, 9, 6, 10, 7, 23))).toBe(local(2026, 9, 6, 11, 0));
    expect(nextGridPoint(HOUR, local(2026, 9, 6, 10, 59, 59))).toBe(local(2026, 9, 6, 11, 0));
  });

  test("90m gives 00:00, 01:30, 03:00 ...", () => {
    expect(nextGridPoint(90 * MIN, local(2026, 9, 6, 10, 7))).toBe(local(2026, 9, 6, 10, 30));
    expect(nextGridPoint(90 * MIN, local(2026, 9, 6, 10, 31))).toBe(local(2026, 9, 6, 12, 0));
    expect(nextGridPoint(90 * MIN, local(2026, 9, 6, 23, 0))).toBe(local(2026, 9, 7, 0, 0));
  });

  test("daily is the next local midnight", () => {
    expect(nextGridPoint(DAY, local(2026, 9, 6, 10, 7))).toBe(local(2026, 9, 7, 0, 0));
    expect(nextGridPoint(DAY, local(2026, 9, 7, 0, 0))).toBe(local(2026, 9, 8, 0, 0));
  });

  test("2d lands on local midnights of every second day counted from local 1970-01-01", () => {
    const first = nextGridPoint(2 * DAY, local(2026, 9, 6, 10, 7));
    const second = nextGridPoint(2 * DAY, first);
    expect(second - first).toBe(2 * DAY);
    for (const t of [first, second]) {
      const d = new Date(t);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
      const wall = t - d.getTimezoneOffset() * MIN;
      expect(wall % (2 * DAY)).toBe(0);
      expect((wall / DAY) % 2).toBe(0);
    }
  });

  test("7m does not divide a day: spacing is exact across midnight, minute marks differ by day", () => {
    let t = local(2026, 9, 6, 23, 30);
    const marks: number[] = [];
    for (let i = 0; i < 20; i++) {
      const next = nextGridPoint(7 * MIN, t);
      expect(next - t).toBeLessThanOrEqual(7 * MIN);
      marks.push(next);
      t = next;
    }
    for (let i = 1; i < marks.length; i++) expect((marks[i] as number) - (marks[i - 1] as number)).toBe(7 * MIN);
    expect(marks.some((m) => new Date(m).getDate() === 7)).toBe(true);
  });

  test("results are on :00 seconds and feeding each result back strictly increases", () => {
    for (const interval of [MIN, 5 * MIN, 7 * MIN, HOUR, 90 * MIN, DAY, 2 * DAY]) {
      let t = local(2026, 9, 6, 10, 7, 23) + 456;
      for (let i = 0; i < 30; i++) {
        const next = nextGridPoint(interval, t);
        expect(next).toBeGreaterThan(t);
        expect(new Date(next).getSeconds()).toBe(0);
        expect(new Date(next).getMilliseconds()).toBe(0);
        t = next;
      }
    }
  });
});

describe("nextGridPoint across a DST change (fake offsets)", () => {
  const change = Date.UTC(2026, 10, 1, 6, 0);
  const cases: Array<[string, (t: number) => number, number]> = [
    ["offset rises by 60 (clocks go back)", shifting(240, 60, change), change],
    ["offset falls by 60 (clocks go forward)", shifting(300, -60, change), change],
  ];

  for (const [label, offset, at] of cases) {
    test(`${label}: never at or before after, always increasing`, () => {
      for (const interval of [MIN, 5 * MIN, 7 * MIN, 30 * MIN, HOUR, 90 * MIN, DAY]) {
        let t = at - 5 * HOUR;
        let previous = t;
        while (t < at + 5 * HOUR) {
          const next = nextGridPoint(interval, t, offset);
          expect(next).toBeGreaterThan(t);
          expect(next).toBeGreaterThan(previous);
          previous = next;
          t = next;
        }
        // From arbitrary starting instants too, seconds included.
        for (let s = at - 3 * HOUR; s < at + 3 * HOUR; s += 7 * MIN + 13_000) {
          expect(nextGridPoint(interval, s, offset)).toBeGreaterThan(s);
        }
      }
    });

    test(`${label}: the 1m grid terminates and reaches the far side`, () => {
      let t = at - HOUR;
      let steps = 0;
      while (t < at + 2 * HOUR) {
        const next = nextGridPoint(MIN, t, offset);
        expect(next).toBeGreaterThan(t);
        t = next;
        steps += 1;
        expect(steps).toBeLessThan(1000);
      }
    });
  }

  test("an hourly point after the change stays on the local hour", () => {
    const offset = shifting(240, 60, change);
    const next = nextGridPoint(HOUR, change + 3 * HOUR + 17 * MIN, offset);
    expect((next - offset(next) * MIN) % HOUR).toBe(0);
  });

  test("a constant offset shifts the wall clock", () => {
    expect(nextGridPoint(HOUR, Date.UTC(2026, 8, 6, 10, 7), fixed(-330))).toBe(Date.UTC(2026, 8, 6, 10, 30));
  });
});

describe("nextGridPoint across real DST rules", () => {
  const newYork = zoneOffset("America/New_York");
  const lordHowe = zoneOffset("Australia/Lord_Howe");

  test("a grid point inside a skipped hour does not occur: 2h in New York on the spring-forward day", () => {
    // 00:00 EST is 05:00Z; 02:00 does not exist; the next even hour is 04:00 EDT.
    expect(nextGridPoint(2 * HOUR, utc("2026-03-08T05:00:00Z"), newYork)).toBe(utc("2026-03-08T08:00:00Z"));
    expect(nextGridPoint(HOUR, utc("2026-03-08T06:00:00Z"), newYork)).toBe(utc("2026-03-08T07:00:00Z"));
  });

  test("a 30-minute skipped stretch: Lord Howe on 2026-10-04", () => {
    expect(nextGridPoint(HOUR, utc("2026-10-03T14:30:00Z"), lordHowe)).toBe(utc("2026-10-03T16:00:00Z"));
    expect(nextGridPoint(45 * MIN, utc("2026-10-03T15:00:00Z"), lordHowe)).toBe(utc("2026-10-03T16:00:00Z"));
  });

  test("a grid point inside a repeated hour occurs in both passes", () => {
    // 01:00 EDT is 05:00Z, 01:00 EST is 06:00Z.
    expect(nextGridPoint(HOUR, utc("2026-11-01T05:00:07Z"), newYork)).toBe(utc("2026-11-01T06:00:00Z"));
    expect(nextGridPoint(5 * MIN, utc("2026-11-01T06:06:32Z"), newYork)).toBe(utc("2026-11-01T06:10:00Z"));
    expect(nextGridPoint(30 * MIN, utc("2026-04-04T14:04:44Z"), lordHowe)).toBe(utc("2026-04-04T14:30:00Z"));
  });

  test("30m in New York on the fall-back day keeps 30 real minutes between points", () => {
    const points: number[] = [];
    let t = utc("2026-11-01T04:59:00Z");
    for (let i = 0; i < 6; i++) {
      t = nextGridPoint(30 * MIN, t, newYork);
      points.push(t);
    }
    expect(points.map((p) => new Date(p).toISOString())).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:00:00.000Z",
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z",
      "2026-11-01T07:30:00.000Z",
    ]);
  });

  test("daily is local midnight on both sides of a DST change", () => {
    const first = nextGridPoint(DAY, utc("2026-03-07T12:00:00Z"), newYork);
    const second = nextGridPoint(DAY, first, newYork);
    expect(new Date(first).toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(new Date(second).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  test("America/New_York: agrees with the walk from every minute within four hours of each transition, for intervals up to 2h", () => {
    const offset = zoneOffset("America/New_York");
    for (const transition of ["2026-03-08T07:00:00Z", "2026-11-01T06:00:00Z"]) {
      for (const interval of [1, 5, 7, 15, 30, 45, 60, 90, 120].map((m) => m * MIN)) {
        for (let after = utc(transition) - 4 * HOUR; after <= utc(transition) + 4 * HOUR; after += MIN) {
          expect(nextGridPoint(interval, after, offset)).toBe(walk(interval, after, offset));
        }
      }
    }
  });

  test("a grid point inside an offset excursion that ends before the interval's far end is found, however long the interval", () => {
    // The offset drops by 60 minutes from day 29 until ten minutes before day 30. The 30d point
    // sits at day 30 by the offset at the start, but by the excursion's offset it falls one hour
    // earlier, inside the excursion, and the offset at day 30 is the base again.
    const excursion = (t: number) => (t >= 29 * DAY && t < 30 * DAY - 10 * MIN ? -60 : 0);
    expect(nextGridPoint(30 * DAY, MIN, excursion)).toBe(30 * DAY - HOUR);
  });

  // Every whole-minute instant is tested by `walk`, so agreement over dense sweeps of
  // each zone's transitions shows the grid is exact there, not only on the cases above.
  const zones: Array<[string, Array<[string, string]>]> = [
    ["America/New_York", [["2026-03-07", "2026-03-10"], ["2026-10-31", "2026-11-03"]]],
    ["Europe/London", [["2026-03-28", "2026-03-31"], ["2026-10-24", "2026-10-27"]]],
    ["Australia/Lord_Howe", [["2026-04-03", "2026-04-06"], ["2026-10-02", "2026-10-05"]]],
    ["Asia/Kathmandu", [["2026-03-07", "2026-03-10"]]],
    ["Asia/Jakarta", [["2026-03-07", "2026-03-10"]]],
  ];
  const intervals = [1, 5, 7, 15, 30, 45, 60, 90, 120, 360, 1440, 2880].map((m) => m * MIN);

  for (const [zone, windows] of zones) {
    test(`${zone}: agrees with the minute-by-minute walk around its transitions, for every interval`, () => {
      const offset = zoneOffset(zone);
      for (const [from, to] of windows) {
        for (const interval of intervals) {
          for (let after = utc(`${from}T00:00:00Z`); after < utc(`${to}T00:00:00Z`); after += 41 * MIN + 13_000) {
            const got = nextGridPoint(interval, after, offset);
            const want = walk(interval, after, offset);
            if (got !== want) {
              throw new Error(`${zone} ${interval / MIN}m after ${new Date(after).toISOString()}: got ${new Date(got).toISOString()}, want ${new Date(want).toISOString()}`);
            }
          }
        }
      }
    });
  }
});

function cron(text: string): Cron {
  const parsed = parseCron(text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** Whether a wall-clock minute matches: each field read off the clock, the day rule applied. */
function matchesWall(c: Cron, wall: number): boolean {
  const d = new Date(wall);
  const day = c.days.has(d.getUTCDate());
  const weekday = c.weekdays.has(d.getUTCDay());
  return (
    c.minutes.has(d.getUTCMinutes()) &&
    c.hours.has(d.getUTCHours()) &&
    c.months.has(d.getUTCMonth() + 1) &&
    (c.eitherDay ? day || weekday : day && weekday)
  );
}

/** The next cron point found by testing every whole minute after `after`: slow, and right by construction. */
function walkCron(c: Cron, after: number, offset: (t: number) => number): number {
  for (let t = (Math.floor(after / MIN) + 1) * MIN; ; t += MIN) {
    if (matchesWall(c, t - offset(t) * MIN)) return t;
  }
}

const iso = (t: number) => new Date(t).toISOString();

describe("AC-C4 cron points on the local clock", () => {
  // With no offset the local clock reads UTC, so instants are written as UTC.
  const at = (text: string, after: string) => iso(nextCronPoint(cron(text), utc(after), fixed(0)));

  test("the next matching minute strictly after: every minute, quarter hours, a weekday morning", () => {
    expect(at("* * * * *", "2026-10-02T10:07:23Z")).toBe("2026-10-02T10:08:00.000Z");
    expect(at("*/15 * * * *", "2026-10-02T10:07:23Z")).toBe("2026-10-02T10:15:00.000Z");
    expect(at("*/15 * * * *", "2026-10-02T10:15:00Z")).toBe("2026-10-02T10:30:00.000Z");
    // 2026-10-02 is a Friday: the next weekday 09:00 is Monday.
    expect(at("0 9 * * 1-5", "2026-10-02T10:00:00Z")).toBe("2026-10-05T09:00:00.000Z");
    expect(at("0 9 * * 1-5", "2026-10-05T08:59:59Z")).toBe("2026-10-05T09:00:00.000Z");
    expect(at("0 0 * * 7", "2026-10-03T12:00:00Z")).toBe("2026-10-04T00:00:00.000Z");
  });

  test("both day fields restricted: a day matching either counts; one starting with * makes a day match both", () => {
    // 30 4 1,15 * 5: the 1st, the 15th, and every Friday. 2026-10-02 and -09 are Fridays, -15 a Thursday.
    expect(at("30 4 1,15 * 5", "2026-10-01T05:00:00Z")).toBe("2026-10-02T04:30:00.000Z");
    expect(at("30 4 1,15 * 5", "2026-10-02T05:00:00Z")).toBe("2026-10-09T04:30:00.000Z");
    expect(at("30 4 1,15 * 5", "2026-10-10T00:00:00Z")).toBe("2026-10-15T04:30:00.000Z");
    // 0 9 */2 * 1: odd-numbered days that are Mondays. October 2026's Mondays are the 5th, 12th, 19th, 26th.
    expect(at("0 9 */2 * 1", "2026-10-01T00:00:00Z")).toBe("2026-10-05T09:00:00.000Z");
    expect(at("0 9 */2 * 1", "2026-10-05T10:00:00Z")).toBe("2026-10-19T09:00:00.000Z");
  });

  test("months, the year's end, and a leap day years away", () => {
    // January 2027 starts on a Friday; its first Monday is the 4th.
    expect(at("0 12 * jan,jul mon", "2026-10-04T00:00:00Z")).toBe("2027-01-04T12:00:00.000Z");
    expect(at("0 0 1 1 *", "2026-06-01T00:00:00Z")).toBe("2027-01-01T00:00:00.000Z");
    expect(at("59 23 31 12 *", "2026-12-31T23:59:00Z")).toBe("2027-12-31T23:59:00.000Z");
    expect(at("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    // 2100 is no leap year, so its next leap day is in 2104.
    expect(at("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBe("2104-02-29T00:00:00.000Z");
  });

  test("results are whole minutes and feeding each result back strictly increases", () => {
    for (const text of ["* * * * *", "*/7 * * * *", "0 9 * * 1-5", "30 4 1,15 * 5", "0 0 29 2 *", "15 2 * * *"]) {
      let t = utc("2026-09-06T10:07:23.456Z");
      for (let i = 0; i < 12; i++) {
        const next = nextCronPoint(cron(text), t, fixed(0));
        expect(next).toBeGreaterThan(t);
        expect(next % MIN).toBe(0);
        t = next;
      }
    }
  });

  test("a leap day years away is found on the real local clock", () => {
    const next = nextCronPoint(cron("0 0 29 2 *"), local(2026, 3, 1, 0, 0));
    const d = new Date(next);
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2028, 2, 29, 0, 0]);
  });
});

describe("AC-C4 cron points across real DST rules", () => {
  const newYork = zoneOffset("America/New_York");
  const lordHowe = zoneOffset("Australia/Lord_Howe");
  const at = (text: string, after: string, offset: (t: number) => number) => iso(nextCronPoint(cron(text), utc(after), offset));

  test("a matching minute inside a skipped hour does not occur: 30 2 * * * skips New York's spring-forward day", () => {
    // 2026-03-08 02:00 EST becomes 03:00 EDT, so 02:30 does not exist that day.
    expect(at("30 2 * * *", "2026-03-07T08:00:00Z", newYork)).toBe("2026-03-09T06:30:00.000Z");
    // */30 at 01:45 EST: 02:00 and 02:30 do not exist; the next is 03:00 EDT.
    expect(at("*/30 * * * *", "2026-03-08T06:45:00Z", newYork)).toBe("2026-03-08T07:00:00.000Z");
  });

  test("a 30-minute skipped stretch: 15 2 * * * skips Lord Howe's 2026-10-04", () => {
    // 01:59 LHST is followed by 02:30 LHDT.
    expect(at("15 2 * * *", "2026-10-03T15:00:00Z", lordHowe)).toBe("2026-10-04T15:15:00.000Z");
  });

  test("a matching minute inside a repeated hour occurs in both passes: 30 1 * * * on New York's fall-back day", () => {
    // 01:30 EDT is 05:30Z, 01:30 EST is 06:30Z.
    expect(at("30 1 * * *", "2026-11-01T05:00:00Z", newYork)).toBe("2026-11-01T05:30:00.000Z");
    expect(at("30 1 * * *", "2026-11-01T05:30:00Z", newYork)).toBe("2026-11-01T06:30:00.000Z");
    expect(at("30 1 * * *", "2026-11-01T06:30:00Z", newYork)).toBe("2026-11-02T06:30:00.000Z");
  });

  // Every whole-minute instant is tested by `walkCron`, so agreement over sweeps of each zone's
  // transitions shows the search is exact there, not only on the cases above.
  const zones: Array<[string, Array<[string, string]>]> = [
    ["America/New_York", [["2026-03-07", "2026-03-10"], ["2026-10-31", "2026-11-03"]]],
    ["Europe/London", [["2026-03-28", "2026-03-31"], ["2026-10-24", "2026-10-27"]]],
    ["Australia/Lord_Howe", [["2026-04-03", "2026-04-06"], ["2026-10-02", "2026-10-05"]]],
    ["Asia/Kathmandu", [["2026-03-07", "2026-03-10"]]],
    ["Asia/Jakarta", [["2026-03-07", "2026-03-10"]]],
  ];
  const expressions = ["* * * * *", "*/7 * * * *", "30 * * * *", "0 2 * * *", "30 1 * * *", "15 2 * * *", "0 */3 * * *", "45 0-3 * * *", "0 9 * * 1-5", "30 4 1,15 * 0"];

  for (const [zone, windows] of zones) {
    test(`${zone}: agrees with the minute-by-minute walk around its transitions, for every expression`, () => {
      const offset = zoneOffset(zone);
      for (const [from, to] of windows) {
        for (const text of expressions) {
          const c = cron(text);
          for (let after = utc(`${from}T00:00:00Z`); after < utc(`${to}T00:00:00Z`); after += 97 * MIN + 13_000) {
            const got = nextCronPoint(c, after, offset);
            const want = walkCron(c, after, offset);
            if (got !== want) throw new Error(`${zone} "${text}" after ${iso(after)}: got ${iso(got)}, want ${iso(want)}`);
          }
        }
      }
    });
  }
});
