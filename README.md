# pi-loop

Re-sends one prompt inside the current pi session on a schedule: an interval or a cron expression.

## Install

```sh
pi install npm:@pwguler/pi-loop
```

Or from GitHub: `pi install git:github.com/pwguler/pi-loop`. Start or reload pi, then `/loop` is available.

## Usage

```
/loop                                    the roster: one row per loop
/loop list                               the same roster
/loop [flags] <text with an interval phrase> [flags]
/loop [flags] <cron expression> <prompt> [flags]
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

```
/loop 5m check the build
/loop check the build hourly
/loop every 30 minutes review the open PRs
/loop run the smoke test every 1h30m --name smoke --max 6
/loop every 50 min @prompt.md
/loop 0 9 * * 1-5 summarize the overnight CI failures
```

- **Interval.** The phrase is cut out of the text, and the rest is the prompt. Forms include `5m`, `2 hours`, `1d`, `1h30m`, `hourly`, `daily`, and `every 30 minutes`; the minimum is `1m`. At the head of the text any form counts. Elsewhere only an `every`/`each` phrase counts; at the tail, so do `hourly`, `daily`, and a compact form such as `5m`. So `summarize the day` has no interval.
- **Cron.** crontab's five fields (minute, hour, day of month, month, day of week), at the head of the text after any flags. A field takes `*`, a value, a range, a list, or a step such as `*/15`. Month and weekday also take names such as `jan` and `mon`. When neither day field starts with `*`, a day that matches either one counts; otherwise a day must match both.
- **Flags.** `--name <n>`, `--max <n>` (remove the loop after its n-th fire), and `--until <ISO|HH:mm>` (remove it at that time; `HH:mm` is the next such local time). Flags go at the head or the tail, never inside the prompt.
- **File prompt.** A prompt that is one `@path` token reads that file, relative to the cwd, at every fire.
- **Name.** Without `--name`, in a session with a model, an `@path` file or a short prompt names the loop. Otherwise the model picks a short name, in a side request that adds nothing to the conversation. With no model or no usable name, the name is `loop-<k>`.
- **Roster.** In the TUI, `/loop` opens the roster below the editor. Its header names the keys for the selected loop: `p` pause or `r` resume, `x` stop (it asks first), Enter for the detail panel, Esc to go back.

## How loops fire

- Nothing fires on create. A loop fires at the points of a fixed grid on the local clock: `1h` at every HH:00, `15m` at :00, :15, :30, and :45, `daily` at 00:00. A cron loop fires at the minutes its expression matches.
- A fire that comes due while the agent is busy is queued behind the running turn. Each loop keeps at most one fire waiting: until the agent settles, its further grid points are skipped. A skip sends nothing and does not count toward `--max`.
- Pause keeps the counter. Resume waits for the next grid point.
- While loops exist, a status line below the editor shows the count and the next due loop.

## State

Loops live in `<cwd>/.pi-loop/` and survive a restart. Only one TUI session in a cwd fires them. Another TUI session in that cwd shows `owned by pid <n>`, and takes over once that process is gone. Grid points that passed while pi was down do not fire.
