// The schedule: every loop runs on a fixed set of points on the local wall clock.

import { nextCronWall, type Cron } from "./cron.ts";
import type { Schedule } from "./types.ts";

const MINUTE_MS = 60_000;
/** The longest stretch crossed in one step. No zone changes its offset twice within it, so an unchanged offset at both ends means no change between. */
const MAX_STEP_MS = 6 * 60 * MINUTE_MS;

/** Minutes west of UTC at an instant, as `Date.getTimezoneOffset` reports them. */
const localOffset = (instant: number): number => new Date(instant).getTimezoneOffset();

/** A loop's next due time: the first point of its schedule strictly after `after`. */
export function nextDue(schedule: Schedule, after: number): number {
  return schedule.cron === undefined ? nextGridPoint(schedule.intervalMs, after) : nextCronPoint(schedule.cron, after);
}

/**
 * The smallest grid point of `intervalMs` strictly after `after`. The grid is
 * every instant at which the local wall clock, counted in milliseconds from
 * local 1970-01-01 00:00, is a multiple of the interval. An interval that
 * divides 24 hours gives the cron pattern from local midnight; one that does
 * not keeps its spacing across midnight. When the clock is set back, a grid
 * point inside the repeated hour occurs in both passes; when it is set
 * forward, a grid point inside the skipped hour does not occur.
 */
export function nextGridPoint(intervalMs: number, after: number, offsetMinutes: (instant: number) => number = localOffset): number {
  return nextPoint((wall) => wall + (((-wall % intervalMs) + intervalMs) % intervalMs), after, offsetMinutes);
}

/** The first whole minute strictly after `after` whose local wall-clock time the cron expression matches. */
export function nextCronPoint(cron: Cron, after: number, offsetMinutes: (instant: number) => number = localOffset): number {
  return nextPoint((wall) => nextCronWall(cron, wall), after, offsetMinutes);
}

/**
 * The first point strictly after `after`, where `firstAtOrAfter(wall)` is the
 * first point at or after a wall-clock time: milliseconds from local
 * 1970-01-01 00:00, read as if the local clock were UTC. Points are whole
 * minutes on the local clock, so a point inside a repeated hour occurs in both
 * passes and one inside a skipped hour does not occur.
 *
 * The search walks real instants, so it is exact around a DST change: from a
 * whole minute it jumps to the next point while the offset is the same at the
 * landing point, and steps one minute at a time across a change of offset.
 */
function nextPoint(firstAtOrAfter: (wall: number) => number, after: number, offsetMinutes: (instant: number) => number): number {
  let t = (Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS;
  // Every wall time in [from, hit] has hit as its first point at or after it, so the search runs once per stretch.
  let from = Infinity;
  let hit = -Infinity;
  for (;;) {
    const offset = offsetMinutes(t);
    const wall = t - offset * MINUTE_MS;
    if (wall < from || wall > hit) {
      from = wall;
      hit = firstAtOrAfter(wall);
    }
    if (hit === wall) return t;
    const target = t + (hit - wall);
    const reach = Math.min(target, t + MAX_STEP_MS);
    if (offsetMinutes(reach) !== offset) t += MINUTE_MS;
    else if (reach === target) return target;
    else t = reach;
  }
}
