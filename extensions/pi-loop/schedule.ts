// The schedule: every loop runs on a fixed grid on the local wall clock.

const MINUTE_MS = 60_000;
/** The longest stretch crossed in one step. No zone changes its offset twice within it, so an unchanged offset at both ends means no change between. */
const MAX_STEP_MS = 6 * 60 * MINUTE_MS;

/** Minutes west of UTC at an instant, as `Date.getTimezoneOffset` reports them. */
const localOffset = (instant: number): number => new Date(instant).getTimezoneOffset();

/**
 * The smallest grid point of `intervalMs` strictly after `after`. The grid is
 * every instant at which the local wall clock, counted in milliseconds from
 * local 1970-01-01 00:00, is a multiple of the interval. An interval that
 * divides 24 hours gives the cron pattern from local midnight; one that does
 * not keeps its spacing across midnight. When the clock is set back, a grid
 * point inside the repeated hour occurs in both passes; when it is set
 * forward, a grid point inside the skipped hour does not occur.
 *
 * The search walks real instants, so it is exact around a DST change: from a
 * whole minute it jumps to the next multiple of the interval while the offset
 * is the same at the landing point, and steps one minute at a time across a
 * change of offset.
 */
export function nextGridPoint(intervalMs: number, after: number, offsetMinutes: (instant: number) => number = localOffset): number {
  let t = (Math.floor(after / MINUTE_MS) + 1) * MINUTE_MS;
  for (;;) {
    const offset = offsetMinutes(t);
    const behind = (((t - offset * MINUTE_MS) % intervalMs) + intervalMs) % intervalMs;
    if (behind === 0) return t;
    const target = t + (intervalMs - behind);
    const reach = Math.min(target, t + MAX_STEP_MS);
    if (offsetMinutes(reach) !== offset) t += MINUTE_MS;
    else if (reach === target) return target;
    else t = reach;
  }
}
