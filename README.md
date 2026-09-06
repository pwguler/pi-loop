# pi-loop

A pi extension that re-sends one prompt on a fixed interval inside the current session. The timer lives in the extension, state lives on disk, and the only text it ever adds to the conversation is the fire itself: one trailing user message per fire, sent through `pi.sendUserMessage`. Nothing before the tail is touched.

Vocabulary is in [CONTEXT.md](CONTEXT.md). Acceptance criteria are in [docs/specs/pi-loop.md](docs/specs/pi-loop.md).

## Install

```bash
pi install ~/workspace/pi-loop
pi list | grep pi-loop
```

Local path install: the code on disk is the code that runs. `pi update --all` does not touch it.

## Usage

```
/loop                             picker: one row per loop; Enter opens the loop, Esc closes
/loop [flags] <text with an interval phrase> [flags]
/loop list                        plain text, one line per loop
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

In the picker, Enter on a loop shows its detail (interval, prompt, next, fires, status, bounds, last error) with rows `pause` or `resume`, `stop`, `back`. `stop` asks first. Each action runs the typed command, so the state file, the notice, and the footer update the same way. Without a UI, bare `/loop` prints `/loop list`.

The interval phrase is cut out of the text; what remains is the prompt.

```
/loop 5m check the build
/loop every 30 minutes review the open PRs
/loop check the build hourly
/loop check the build, every 2 hours, and report
/loop run the smoke test every 1h30m --name smoke --max 6
/loop every 50 min @prompt.md
```

- Interval forms: `5m`, `5 min`, `2 hours`, `1d`, `hourly`, `daily`, `every hour`, `each day`, `1h30m`, `1 hour 30 minutes`. Minimum `1m`.
- At the head or the tail of the text any form counts. In the middle only an `every`/`each` phrase counts, so `wait 5 minutes then retry` is prompt text, not an interval. Two phrases reject; say one.
- Flags: `--name <n>`, `--max <n>`, `--until <ISO|HH:mm>`. Head or tail, never inside the prompt.
- The loop fires once on create, then every interval, counted from the fire itself. A tick that comes due while the agent is busy fires once when the agent settles.
- `@path` reads the file at every fire, relative to the cwd. A missing or empty file skips that fire and shows the error in `/loop list`; the loop stays alive.
- `--name` defaults to `loop-<k>` with the lowest free `k`.
- `--max n` removes the loop after its n-th fire. `--until` removes it at that time; `HH:mm` means the next such local time.
- Pause keeps the counter. Resume counts the next due from the resume moment.

## Status line

While loops exist, one line in pi's footer:

```
1 active · next loop-1 02:42              steady: counts and the earliest due active loop
2 active, 1 paused · due fast             fast is overdue and the agent is busy; it fires on settle
2 active · fired fast #6                  for 5s after a fire, then back to next
1 paused                                  everything paused
2 loops · owned by pid 4242               this session is not the owner
3 active · next b 10:05 · 1 error         some loop has a last error; /loop list has the message
```

The count carries the state in the theme's colors: `success` steady, `warning` due, `accent` fired, `dim` all paused, `muted` non-owner. The loop name is `accent`, the error suffix `error`, separators and times `dim`. No loops, no line. The footer is written through `ctx.ui.setStatus` only, and only when the text changes. Spec: [docs/specs/pi-loop-status.md](docs/specs/pi-loop-status.md).

Each fire is one user message:

```
[loop <name> #<fires> <YYYY-MM-DD HH:mm>]
<prompt text>
```

That is the stored text and what the model sees. On screen the whole message is drawn as one heading line, `<name> #<fires> · <YYYY-MM-DD HH:mm>`, through pi's display-only Markdown transformer; the prompt text is not repeated in the transcript. The loop's detail shows it.

## State

```
<cwd>/.pi-loop/loops.json   every loop: name, intervalMs, prompt source, dueAt, fires, paused, bounds, last error
<cwd>/.pi-loop/owner.json   {pid, sessionId, claimedAt}: the one session in this cwd that fires
```

Only the owner fires. A second pi session in the same cwd lists the loops as `owned by pid <n>` and fires nothing. When the owner pid is dead, the next session takes over. Owner shutdown removes `owner.json`. A restart in the same cwd resumes every non-stopped loop; a loop whose due time passed while pi was down fires once at the first idle moment, then continues on cadence from that fire.

Loop state is never read from the conversation. Compaction, `/tree`, and forks do not change a counter or a due time. Sessions without a UI (`pi -p`, RPC) never claim ownership and never fire.

## Verification

```bash
cd ~/workspace/pi-loop
bun test                                   # AC-1..AC-9, AC-12 against a mock pi host
bun run check                              # tsc; also proves pi's ExtensionAPI satisfies the host surface used
grep -rnE 'cache_control|"ttl"|\bttl\s*[:=]|pi\.on\("context"|systemPrompt' extensions ; test $? -eq 1   # AC-10
grep -rn 'sendUserMessage\|sendMessage' extensions | grep -v sendUserMessage ; test $? -eq 1              # AC-10
```

### Prompt-cache acceptance on the pengepul stack

Before enabling this in a workspace behind the pengepul relay, run the acceptance procedure at https://gist.github.com/pwguler/643d6fb6beaadb67d216681f5f2bc89d (`tap.py`, `prefixdiff.py`, `usage.py`). Two points specific to pi-loop:

- Step 2 is only meaningful armed: a loop must be scheduled in the fixture workspace, since the timer lives in the extension. Two prompts with no loop running prove nothing.
- Step 3 is the one that matters (spec AC-11). Keep the tap up, let the interval fire at least once, then `prefixdiff.py` the request the timer sent: every index below the tail must read `identical`, and `usage.py` must show that turn writing roughly the size of the prompt, with `total` otherwise unchanged. `cacheRead` on the fire turn must be at least 90% of the previous turn's `cacheRead + cacheWrite`.

By construction: no `context` hook, no `before_agent_start`, no system prompt change, no `cache_control`, no TTL. The fire goes through `pi.sendUserMessage`, which is the same path as a typed message, so it lands as a stored user message in the transcript, not a per-send injection. An ephemeral message at the tail would never match on the next send; this one is stored once and stays byte-identical.

Keep the interval below the cache retention in force. Against a `1h` cache, `60m` misses by the seconds a turn takes; `50m` is the interval that holds.

## Layout

```
extensions/pi-loop.ts   the extension: one command, three event handlers
tests/mock-pi.ts        mock pi host with injected clock, pid, liveness, ticker; sessionManager throws on any history read
tests/pi-loop.test.ts   one describe per acceptance criterion
```
