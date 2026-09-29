# pi-loop

A pi extension for loop.

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
pi install git:github.com/pwguler/pi-loop@v0.2.0
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
/loop stop <name>
/loop pause <name>
/loop resume <name>
```

In the TUI, both forms open the roster; so does → on an empty prompt editor. The status line expands in place into a header and one row per loop (name, status, next, interval, fires); at most 8 rows show, and the window scrolls with the selection:

```
loops · ↑↓/jk select · enter open · esc back
```

↑↓ or j/k select, Enter opens the selected loop's detail panel, Esc goes back to the status line, and so does ↑ on the first row. Any other key closes the roster and goes to the editor. With no loops, both forms print `no loops`.

The detail panel (interval, prompt, next, fires, status, bounds, last error) is drawn like pi's own dialogs, with single keys along the bottom:

```
p pause  x stop  escape/ctrl+c back        (p resume when the loop is paused)
```

`x` asks first. Each key runs the typed command, so the state file, the notice, and the status line update the same way, and the roster comes back showing the change. Outside the TUI (print, json, RPC), both forms print one text line per loop instead.

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
- At the head of the text any form counts. At the tail only an `every`/`each` phrase, a compact form (`5m`, `2h`, `1d`, `1h30m`), `hourly`, or `daily` counts, so `summarize the day` has no interval and `5m check the last 3 days` keeps its duration in the prompt. In the middle only an `every`/`each` phrase counts, so `wait 5 minutes then retry` is prompt text, not an interval. Two phrases reject (`5m check again in 10m`); say one. An `and`/`then` a head phrase leaves at the start of the prompt is dropped: `1m and then ping` sends `ping`.
- Flags: `--name <n>`, `--max <n>`, `--until <ISO|HH:mm>`. Head or tail, never inside the prompt. Tail flags are read before the interval, so `--name daily` is a name, not an interval.
- The loop fires once on create, then on its schedule: a fixed grid on the local wall clock, whatever time earlier fires went out. `1h` fires at every HH:00, `15m` at :00, :15, :30, :45, `daily` at 00:00, `90m` at 00:00, 01:30, 03:00. An interval that does not divide 24 hours, such as `7m`, keeps its spacing across midnight. On a DST day the grid stays on the local clock: a point inside a repeated hour occurs in both passes, a point inside a skipped hour does not occur. A loop that comes due while the agent is busy is sent at once and queued behind the running turn as a follow-up. A loop keeps at most one fire waiting: from a send made while the agent is busy until the agent settles, the loop's further grid points are skipped. A skip sends nothing, does not count toward `--max`, and moves the loop's next due time to the next grid point. Fires of different loops never skip each other. A `1m` loop whose turns take 5 minutes runs one fire per turn and skips the grid points in between. One loop fires per tick, earliest due first, so loops due together go out one second apart. While pi compacts or summarizes, a due fire is held back and goes out on the first tick after.
- A prompt that is one `@path` token reads the file at every fire, relative to the cwd. A missing or empty file skips that fire and shows the error in the loop's detail panel and the text listing; the loop stays alive. A prompt that goes on past the `@` word is text: `@alice please review` is sent as written.
- Without `--name`, in a session with a model, the loop is named before it is created and first fires, by the first rule that applies: an `@path` prompt takes the file's name (`@prompt.md` → `prompt`); a prompt of up to 3 words that already makes a name of at most 16 characters is used as it is (`ping` → `ping`, `check build` → `check-build`); otherwise the session's model picks a 1–3 word hyphenated name of at most 16 characters, in one side request that adds nothing to the conversation and is given up after 20 seconds. A taken name gets `-2`, `-3`.
- With no model, a failed or timed-out call, no usable answer, or a file name that leaves nothing, the name is `loop-<k>` with the lowest free `k`. When the model was tried and failed, the create notice says why: `· naming timed out`, `· naming failed`, `· naming gave no usable name`.
- `--max n` removes the loop after its n-th fire. `--until` removes it at that time; `HH:mm` means the next such local time.
- Pause keeps the counter. Resume waits for the next grid point after the resume moment.

## Status line

While loops exist, and for 5s after the last loop's final fire, one line shows directly below the prompt editor, above pi's footer. Otherwise there is no line.

```
1 active loop · next daily-greeting 00:00 · → to manage      steady: counts and the earliest due active loop
2 active loops, 1 paused · due fast · → to manage            fast is due but cannot be sent yet, for example during a compaction
2 active loops · fired fast #6 · → to manage                 for 5s after a fire, then back to next
2 paused loops · → to manage                                 everything paused
3 active loops · next b 10:05 · 1 error · → to manage        some loop has a last error; its detail panel has the message
2 loops · owned by pid 4242 · → to manage                    this session is not the owner
fired smoke #6                                               the last loop reached --max on that fire; 5s, then no line
```

The line uses the tones of pi-subagents' fleet line: the count is `muted` (so is the pulse-only line `fired <name> #<n>`), a plain ` · ` follows it, and the rest (the next, due, fired, or owner clause, the error suffix, and the `→ to manage` hint) is one `dim` segment. Nothing in the line is bold or colored beyond those two tones. The line is redrawn only when its text changes.

pi offers each key to the extensions' terminal listeners in the order they registered, which follows the package order in settings, and the first listener that consumes a key keeps it. pi-subagents opens its roster with ↓ or ← on an empty editor while it has active runs, and pi-loop opens its roster with →, so with both rosters closed each key has one owner. With pi-loop listed first in the package list, ← inside pi-loop's open roster closes it and opens pi-subagents' roster when that is closed, and → while pi-subagents' roster is open also opens pi-loop's roster, which then takes ↓, ↑, j, k, Enter, and Esc before pi-subagents' roster does, until it closes. With pi-subagents listed first, ↓ and ← inside pi-loop's open roster reach pi-subagents first and open its roster while pi-loop's stays open, and pi-subagents then takes ↓, ↑, j, k, Enter, and Esc before pi-loop's roster does; use j and k to move in pi-loop's roster before opening pi-subagents'.

Each fire is one user message:

```
[loop <name> #<fires> <YYYY-MM-DD HH:mm>]
<prompt text>
```

That is the stored text and what the model sees. On screen the whole message is drawn as one plain line, `<name> #<fires> · <YYYY-MM-DD HH:mm>`, through pi's display-only Markdown transformer; the prompt text is not repeated in the transcript. The loop's detail shows it.

## State

```
<cwd>/.pi-loop/loops.json   every loop: name, intervalMs, prompt source, dueAt, fires, paused, bounds, last error
<cwd>/.pi-loop/owner.json   {pid, sessionId, claimedAt}: the one session in this cwd that fires
```

Only the owner fires. A second pi session in the same cwd lists the loops as `owned by pid <n>` and fires nothing. When the owner pid is dead, the next session takes over. Owner shutdown removes `owner.json`. A restart in the same cwd resumes every non-stopped loop; a grid point that passed while pi was down is skipped: when a session takes ownership, every active loop that has fired before waits for its next grid point and nothing is sent for the missed ones. A loop that has not fired yet still fires at the first tick that can send.

Loop state is never read from the conversation. Compaction, `/tree`, and forks do not change a counter or a due time. Only TUI sessions claim ownership and fire. Print, json, and RPC sessions never do, a pi-subagents child running as RPC included; their `/loop` commands still write the state file, and the TUI owner fires those loops.

## Verification

```bash
bun test          # behavior against a mock pi host: firing, persistence, ownership, bounds, status line, roster
bun run typecheck # tsc; also proves pi's ExtensionAPI satisfies the host surface used, every event pi-loop subscribes to included (tests/host-contract.ts)
grep -rnE 'cache_control|"ttl"|\bttl\s*[:=]|pi\.on\("context"|systemPrompt' extensions ; test $? -eq 1
grep -rn 'sendUserMessage\|sendMessage' extensions | grep -v sendUserMessage ; test $? -eq 1
```

The two greps hold the line the extension exists for: no cache markers, no TTL, no context hook, no system prompt change, and `sendUserMessage` as the only path that adds text to the conversation.

## Releasing

Releases publish from CI on a version tag. Bump, tag, push:

```sh
VERSION=0.2.0
npm version "$VERSION" --no-git-tag-version
git add package.json   # plus bun.lock if the bump changed it
git commit -m "chore(release): v$VERSION"
git tag "v$VERSION"
git push origin main --tags
```

`.github/workflows/publish.yml` then runs typecheck and the full test suite and
refuses the release unless the tag matches `package.json`, the tagged commit is
on `main`, and the version is not already on the registry. It publishes with a
provenance attestation linking the tarball to this repository and commit.

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
