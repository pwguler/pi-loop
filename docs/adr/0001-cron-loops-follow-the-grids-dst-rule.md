# Cron loops follow the interval grid's DST rule

A cron loop's grid points are the whole minutes whose local wall-clock time its expression matches. So a matching minute inside a skipped hour does not occur, and one inside a repeated hour occurs twice, exactly as for an interval loop's grid. cron(8) instead runs a fixed-time job from a skipped hour right after the jump and runs it once in a repeated hour. That would be a second DST rule, keyed on whether the expression has a wildcard in its minute or hour field. It was turned down so every loop follows one rule, and one walk over real instants finds the next due time for both kinds of schedule.

## Consequences

In zones that change the clock at 02:00, such as America/New_York, `30 2 * * *` does not fire on the spring-forward day, and `30 1 * * *` fires twice on the fall-back day.
