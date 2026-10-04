# pi-loop

A pi extension for loop

## Install

From npm:

```sh
pi install npm:@pwguler/pi-loop
```

Or straight from GitHub (no npm account needed):

```sh
pi install git:github.com/pwguler/pi-loop
```

Pin a release so updates don't move under you:

```sh
pi install git:github.com/pwguler/pi-loop@v0.5.0
```

To update a git-installed package later, install the next tag the same way. Start or reload pi, then `/loop` is available. To try it without installing, use `pi -e git:github.com/pwguler/pi-loop`.

For development, install the checkout by path; the code on disk is the code that runs and `pi update --all` does not touch it:

```sh
pi install ./pi-loop
```

## Usage

```
/loop                             the roster: one row per loop
/loop list                        the same roster
/loop [flags] <text with an interval phrase> [flags]
/loop [flags] <cron expression> <prompt> [flags]
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

In the TUI, both forms open the roster, and so does alt+l while the prompt editor has focus, with or without text in it. The status line expands in place into a header and one row per loop (name, status, next, schedule, fires); at most 8 rows show, and the window scrolls with the selection. The header names the keys for the selected loop:

```
loops · ↑↓/jk select · p pause · x stop · enter open · esc back
loops · ↑↓/jk select · r resume · x stop · enter open · esc back
```

↑↓ or j/k select, and Enter opens the selected loop's detail panel. p pauses the selected loop and r resumes it, and the roster stays open on that loop. x asks `Stop <name>?`; yes stops the loop, and the roster stays open on the row that takes its place, or the last row. Esc goes back to the status line. So does ↑ on the first row, and alt+l on any row. Any other key closes the roster and goes to the editor. With no loops, both forms and alt+l print `no loops`.

alt+l arrives as Esc followed by l, so it works without the kitty keyboard protocol. pi joins the two into alt+l when they arrive within 10 ms, or 100 ms over SSH; for a slower multiplexer or link, set `PI_TUI_ESC_TIMEOUT` to a larger number of milliseconds. On macOS the Option key has to send Meta (Esc+), for example with iTerm2's "Esc+" setting, Terminal.app's "Use Option as Meta key", or Ghostty's `macos-option-as-alt`. In a terminal without the kitty keyboard protocol, repeats arrive as presses, so holding alt+l toggles the roster. `/loop` opens the roster in any terminal. If another extension also registers alt+l, pi keeps the one loaded last and prints a warning.

The detail panel (interval or cron expression, prompt, next, fires, status, bounds, last error) is drawn like pi's own dialogs, with single keys along the bottom. The first key follows the loop's state:

```
p pause  x stop  escape/ctrl+c back
r resume  x stop  escape/ctrl+c back
```

p pauses an active loop and r resumes a paused one. The key that does not apply does nothing, in the panel and in the roster. `x` asks first, in the panel and in the roster. Stopping the last loop closes the roster and removes the status line. Each key runs the typed command, so the state file, the notice, and the status line update the same way, and the roster shows the change. Outside the TUI (print, json, RPC), both forms print one text line per loop instead.

The interval phrase or cron expression is cut out of the text; what remains is the prompt.

```
/loop 5m check the build
/loop every 30 minutes review the open PRs
/loop check the build hourly
/loop check the build, every 2 hours, and report
/loop run the smoke test every 1h30m --name smoke --max 6
/loop every 50 min @prompt.md
/loop 0 9 * * 1-5 summarize the overnight CI failures
/loop */15 9-17 * * mon-fri check the build --max 20
```

- Interval forms: `5m`, `5 min`, `2 hours`, `1d`, `hourly`, `daily`, `every hour`, `each day`, `1h30m`, `1 hour 30 minutes`. Minimum `1m`.
- At the head of the text any form counts. At the tail only an `every`/`each` phrase, a compact form (`5m`, `2h`, `1d`, `1h30m`), `hourly`, or `daily` counts, so `summarize the day` has no interval and `5m check the last 3 days` keeps its duration in the prompt. In the middle only an `every`/`each` phrase counts, so `wait 5 minutes then retry` is prompt text, not an interval. Two phrases reject (`5m check again in 10m`); say one. An `and`/`then` a head phrase leaves at the start of the prompt is dropped: `1m and then ping` sends `ping`.
- Flags: `--name <n>`, `--max <n>`, `--until <ISO|HH:mm>`. Head or tail, never inside the prompt. Tail flags are read before the interval, so `--name daily` is a name, not an interval.
- A cron expression is crontab's five fields: minute (0-59), hour (0-23), day of month (1-31), month (1-12 or `jan`-`dec`), and day of week (0-7 or `sun`-`sat`, where 0 and 7 are both Sunday). A field is `*`, a value, a range (`1-5`), a list (`1,15`), or a step on `*` or a range (`*/15`, `0-30/10`). In the month and weekday fields, names work wherever a number does, in upper or lower case, and `fri-sun` runs Friday to Sunday. When neither day field starts with `*`, a day that matches either one counts, as in cron: `30 4 1,15 * 5` fires on the 1st, the 15th, and every Friday. Otherwise a day must match both, so `0 9 */2 * 1` fires on Mondays that fall on an odd-numbered day.
- A cron expression counts only at the head of the text, after any head flags. A sixth field-like token right after it rejects instead of starting the prompt, which catches the seconds-first and year forms, such as `0 0 9 * * 1-5`. A `,` `;` `:` `.` or `!` after the fifth field ends the expression and is dropped, and so is an `and`/`then` after it: `0 9 * * 1-5: 3 reviews` sends `3 reviews`. Behind a cron expression the interval rules for the middle and the tail still apply, and a phrase that counts there rejects with the cron expression; say one. So `0 9 * * 1-5 check the build hourly` rejects, and `0 9 * * 1-5 daily standup notes` sends `daily standup notes`. There are no `@daily`-style macros, since `@` starts a file prompt; `hourly` and `daily` are interval phrases.
- Nothing fires on create. The loop first fires at its first grid point, then at every grid point after it: a fixed grid on the local wall clock, whatever time earlier fires went out. `1h` fires at every HH:00, `15m` at :00, :15, :30, :45, `daily` at 00:00, `90m` at 00:00, 01:30, 03:00. An interval that does not divide 24 hours, such as `7m`, keeps its spacing across midnight. A cron loop's grid points are the local minutes its expression matches. On a DST day the grid stays on the local clock: a point inside a repeated hour occurs in both passes, a point inside a skipped hour does not occur. A loop that comes due while the agent is busy is sent at once and queued behind the running turn as a follow-up. A loop keeps at most one fire waiting: from a send made while the agent is busy until the agent settles, the loop's further grid points are skipped. A skip sends nothing, does not count toward `--max`, and moves the loop's next due time to the next grid point. Fires of different loops never skip each other. A `1m` loop whose turns take 5 minutes runs one fire per turn and skips the grid points in between. One loop fires per tick, earliest due first, so loops due together go out one second apart. While pi compacts or summarizes, a due fire is held back and goes out on the first tick after.
- A prompt that is one `@path` token reads the file at every fire, relative to the cwd. A missing or empty file skips that fire and shows the error in the loop's detail panel and the text listing; the loop stays alive. A prompt that goes on past the `@` word is text: `@alice please review` is sent as written.
- Without `--name`, in a session with a model, the loop is named before it is created. The first rule that applies names it. An `@path` prompt takes the file's name (`@prompt.md` → `prompt`). A prompt of up to 3 words that already makes a name of at most 16 characters is used as it is (`ping` → `ping`, `check build` → `check-build`). Otherwise the session's model picks a 1–3 word hyphenated name of at most 16 characters, in one side request that adds nothing to the conversation and is given up after 20 seconds. A taken name gets `-2`, `-3`.
- With no model, a failed or timed-out call, no usable answer, or a file name that leaves nothing, the name is `loop-<k>` with the lowest free `k`. When the model was tried and failed, the create notice says why: `· naming timed out`, `· naming failed`, `· naming gave no usable name`.
- `--max n` removes the loop after its n-th fire. `--until` removes it at that time; `HH:mm` means the next such local time.
- Pause keeps the counter. Resume waits for the next grid point after the resume moment.

### Cost

A fire starts a run, and every model request in that run reads the whole conversation so far. A fire whose run calls tools makes several requests. pi-loop adds only the fire at the end, so with prompt caching the conversation so far is a cache read, and the fire's first request writes only the last reply and the fire. The cost of a fire therefore grows with the length of the session, not with the prompt. In one measured session, all 120 fires read the whole conversation from cache. At about 560,000 tokens, a fire answered without tools wrote about 40 tokens and cost about $0.28 with that session's model, about $17 an hour for a `1m` loop. A provider's cache expires after a while without requests, so a fire after a long gap can write the whole conversation to the cache again, which costs more than a read. With `"cacheWarming": "idle"` in pi's settings, pi can keep the cache alive between runs for models that declare a cache lifetime.

- Run frequent loops in a short session of their own.
- Bound a loop with `--max` or `--until`, and pause a loop you are not watching (`/loop pause <name>`). A paused loop sends nothing and costs nothing.
- A loop keeps at most one fire waiting behind a busy run, so a slow session does not multiply fires.

## Status line

While loops exist, and for 5s after the last loop's final fire, one line shows below the prompt editor, above pi's footer. Otherwise there is no line. The line stacks with other extensions' below-editor lines, such as pi-subagents' fleet line, in the order they first appeared. A line that disappears and shows again moves below the others. The roster keys do not depend on this order.

```
  1 active loop · next daily-greeting 00:00 · alt+l to manage      steady: counts and the earliest due active loop
  1 active loop · next standup 09-14 09:00 · alt+l to manage       due more than 24 hours from now: MM-DD before the time
  2 active loops, 1 paused · due fast · alt+l to manage            fast is due but cannot be sent yet, for example during a compaction
  2 active loops · fired fast #6 · alt+l to manage                 for 5s after a fire, then back to next
  2 paused loops · alt+l to manage                                 everything paused
  3 active loops · next b 10:05 · 1 error · alt+l to manage        some loop has a last error; its detail panel has the message
  2 loops · owned by pid 4242 · alt+l to manage                    this session is not the owner
```

The line uses the tones of pi-subagents' fleet line. The count is `muted` and a plain ` · ` follows it. Everything after that is one `dim` segment: the next, due, fired, or owner clause, the error suffix, and the `alt+l to manage` hint. When the last loop ends on its `--max` fire, the line reads `fired <name> #<n>` alone, in `muted`, for 5s and then disappears. Nothing in the line is bold or colored beyond those two tones. The line is redrawn only when its text changes.

pi offers each key to the extensions' terminal listeners in the order they registered, which follows the package order in settings. The first listener that consumes a key keeps it. Extension shortcuts run after all listeners, from the prompt editor, so alt+l reaches pi-loop only after every listener let it pass. pi-subagents opens its roster with ↓ or ← on an empty editor while its fleet line shows. pi-loop's closed roster leaves ↓, ←, and → to their usual owners. alt+l while pi-subagents' roster is open closes that roster, which passes keys it does not own, and opens pi-loop's, in either package order. With pi-loop listed first in the package list, ← inside pi-loop's open roster closes it and opens pi-subagents' roster if that is closed. With pi-subagents listed first, ↓ and ← inside pi-loop's open roster reach pi-subagents first and open its roster while pi-loop's stays open. pi-subagents then takes ↓, ↑, j, k, Enter, and Esc first; use j and k to move in pi-loop's roster before opening pi-subagents'.

Each fire is one user message:

```
[loop <name> #<fires> <YYYY-MM-DD HH:mm>]
<prompt text>
```

That is the stored text and what the model sees. On screen the whole message is drawn as one plain line, `<name> #<fires> · <YYYY-MM-DD HH:mm>`, through pi's display-only Markdown transformer; the prompt text is not repeated in the transcript. The loop's detail shows it.

## State

```
<cwd>/.pi-loop/loops.json   every loop: name, intervalMs or cron, prompt source, dueAt, fires, paused, bounds, last error
<cwd>/.pi-loop/owner.json   {pid, sessionId, claimedAt}: the one session in this cwd that fires
```

Only the owner fires. A second pi session in the same cwd lists the loops as `owned by pid <n>` and fires nothing. When the owner pid is dead, the next session takes over. Owner shutdown removes `owner.json`. A restart in the same cwd resumes every non-stopped loop. Grid points that passed while pi was down do not fire: when a session takes ownership, every active loop waits for its next grid point.

Loop state is never read from the conversation. Compaction, `/tree`, and forks do not change a counter or a due time. Only TUI sessions claim ownership and fire. Print, json, and RPC sessions never do, a pi-subagents child running as RPC included; their `/loop` commands still write the state file, and the TUI owner fires those loops.

## Verification

```bash
bun test          # behavior against a mock pi host: firing, persistence, ownership, bounds, status line, roster; the grid and the cron grammar
bun run typecheck # tsc; also proves pi's ExtensionAPI satisfies the host surface used, every event pi-loop subscribes to included (tests/host-contract.ts)
grep -rnE 'cache_control|"ttl"|\bttl\s*[:=]|pi\.on\("context"|systemPrompt' extensions ; test $? -eq 1
grep -rn 'sendUserMessage\|sendMessage' extensions | grep -v sendUserMessage ; test $? -eq 1
```

The two greps hold the line the extension exists for: no cache markers, no TTL, no context hook, no system prompt change, and `sendUserMessage` as the only path that adds text to the conversation.

## Releasing

Releases publish from CI on an annotated version tag. The tag message holds the
release notes. Bump, commit, write the notes, tag, push:

```sh
VERSION=0.5.0
npm version "$VERSION" --no-git-tag-version
git add package.json   # plus bun.lock if the bump changed it
git commit -m "chore(release): v$VERSION"
NOTES="/tmp/pi-loop-v$VERSION.md"
$EDITOR "$NOTES"       # release notes, house format below
git tag -a --cleanup=verbatim -F "$NOTES" "v$VERSION"
git push origin main "v$VERSION"
```

The notes follow the house format: a lead paragraph, then **Changes**,
**Upgrading**, **Install**, **Verified** (including what was not run), and a
**Full changelog** compare link. `--cleanup=verbatim` keeps lines that start
with `#`; the default cleanup deletes them, Markdown headings included.

`.github/workflows/publish.yml` then runs typecheck and the full test suite. It
refuses the release unless the tag matches `package.json`, the tagged commit is
on `main`, the version is not already on the registry, and the tag is annotated
with a non-empty message. It publishes to npm with a provenance attestation
linking the tarball to this repository and commit. A last job creates the
GitHub Release from the tag message, and skips it if that release exists. If
`npm publish` succeeds and that last job fails, re-run the failed job only:
re-running all jobs stops at the registry check, because the version is already
published.

To bump the pi devDependency, run `bun update` for all four pi packages, since
bun otherwise keeps the resolved versions of the `*` peers:

```sh
bun update @earendil-works/pi-coding-agent @earendil-works/pi-ai \
  @earendil-works/pi-tui @earendil-works/pi-agent-core
```

`bun update` also rewrites `package.json`. Before committing, set the pi
devDependency back to an exact version, set the peerDependencies back to `"*"`,
remove any `dependencies` block it added, and run `bun install` so `bun.lock`
matches `package.json` again.

Publishing needs a repository secret named `NPM_TOKEN`, holding a granular
access token:

- **Permissions**: *Read and write*. *Read-only*, and the *stage only* variant
  of read and write, cannot run `npm publish`.
- **Packages and scopes**: *All packages*.
- **Bypass two-factor authentication**: ticked. A token that prompts for an OTP
  cannot publish unattended.
- **Expiration**: whatever you will actually remember to rotate. When it lapses,
  the release fails at the publish step.

On the token form, leave **Organizations** at *No access*: this package lives in
a user scope (`@pwguler`), not an organization, so a personal account has
nothing to select there. Choosing *Only select packages and scopes* instead of
*All packages* asks for a scope selection that such an account cannot satisfy.

`.github/workflows/ci.yml` runs typecheck and tests on pull requests and pushes
to `main`, and is the same gate the publish job depends on.

## License

MIT
