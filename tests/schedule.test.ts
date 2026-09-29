// The grid of docs/specs/pi-loop.md AC-16, on the local wall clock.

import { describe, expect, test } from "bun:test";
import { nextGridPoint } from "../extensions/pi-loop/schedule.ts";

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
