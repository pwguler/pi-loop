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
/loop <interval> [--name <n>] [--max <n>] [--until <ISO|HH:mm>] <prompt | @file>
/loop list          same as bare /loop
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

- Interval: `5m`, `2h`, `1d`. Minimum `1m`.
- The loop fires once on create, then every interval, counted from the fire itself. A tick that comes due while the agent is busy fires once when the agent settles.
- `@path` reads the file at every fire, relative to the cwd. A missing or empty file skips that fire and shows the error in `/loop list`; the loop stays alive.
- `--name` defaults to `loop-<k>` with the lowest free `k`.
- `--max n` removes the loop after its n-th fire. `--until` removes it at that time; `HH:mm` means the next such local time.
- Pause keeps the counter. Resume counts the next due from the resume moment.

Each fire is one user message:

```
[loop <name> #<fires> <YYYY-MM-DD HH:mm>]
<prompt text>
```

## State

```
<cwd>/.pi-loop/loops.json   every loop: name, interval, prompt source, dueAt, fires, paused, bounds, last error
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
