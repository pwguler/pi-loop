# pi-loop

Recurring prompts inside a pi session. Each loop fires its prompt on its interval as one trailing user message, keeps its count across restarts, and adds nothing else to the conversation: no context hook, no injected text, no cache marker. State is two JSON files in the workspace.

## Install

```bash
pi install ~/workspace/pi-loop
pi list | grep pi-loop
```

Local path install: the code on disk is the code that runs. `pi update --all` does not touch it.

## Usage

```
/loop                             picker: one row per loop; Enter opens the loop, Esc closes
/loop list                        the same picker
/loop [flags] <text with an interval phrase> [flags]
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

In the picker, Enter on a loop opens its detail panel (interval, prompt, next, fires, status, bounds, last error) drawn like pi's own dialogs, with single keys along the bottom:

```
p pause  x stop  escape/ctrl+c back        (p resume when the loop is paused)
```

`x` asks first. Each key runs the typed command, so the state file, the notice, and the footer update the same way, and the list comes back showing the new state. Without a UI (`pi -p`, RPC), both forms print one text line per loop instead.

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

The count carries the state in the theme's colors: `success` steady, `warning` due, `accent` fired, `dim` all paused, `muted` non-owner. The loop name is `accent`, the error suffix `error`, separators and times `dim`. No loops, no line. The footer is written through `ctx.ui.setStatus` only, and only when the text changes.

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

Only the owner fires. A second pi session in the same cwd lists the loops as `owned by pid <n>` and fires nothing. When the owner pid is dead, the next session takes over. Owner shutdown removes `owner.json`. A restart in the same cwd resumes every non-stopped loop; a loop whose due time passed while pi was down fires once at the first idle moment, then continues on its interval from that fire.

Loop state is never read from the conversation. Compaction, `/tree`, and forks do not change a counter or a due time. Sessions without a UI (`pi -p`, RPC) never claim ownership and never fire.

## Verification

```bash
bun test          # behavior against a mock pi host: firing, persistence, ownership, bounds, footer, picker
bun run check     # tsc; also proves pi's ExtensionAPI satisfies the host surface used
grep -rnE 'cache_control|"ttl"|\bttl\s*[:=]|pi\.on\("context"|systemPrompt' extensions ; test $? -eq 1
grep -rn 'sendUserMessage\|sendMessage' extensions | grep -v sendUserMessage ; test $? -eq 1
```

The two greps hold the line the extension exists for: no cache markers, no TTL, no context hook, no system prompt change, and `sendUserMessage` as the only path that adds text to the conversation.

## Layout

```
extensions/pi-loop.ts   the extension: one command, three event handlers
tests/mock-pi.ts        mock pi host with injected clock, pid, liveness, ticker; sessionManager throws on any history read
tests/pi-loop.test.ts   one describe per acceptance criterion
```
