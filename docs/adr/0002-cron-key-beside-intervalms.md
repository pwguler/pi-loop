# loops.json stores a cron loop with a cron key in place of intervalMs

A cron loop is stored as `cron: "<five fields>"` where an interval loop has `intervalMs`, and a record has exactly one of the two. The other option was a tagged `schedule: { kind, ... }` field. That would change every record, so a pi-loop release without it would reject every loops.json. With a key per kind, interval records keep the shape they had, and only a file that holds a cron loop is new to an older release.

## Consequences

A pi-loop release that predates cron schedules reports `unexpected shape, fix or delete it` for a loops.json holding a cron loop, and fires none of its loops. The expression is stored as typed and parsed on every read. No parsed form is written to disk.
