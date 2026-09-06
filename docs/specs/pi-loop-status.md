# pi-loop-status

## Goal
One line in pi's footer that says how many loops exist, which fires next, and for five seconds after a fire, which loop just fired.

## Non-goals
- No widget, no custom footer, no transcript entry, no notify per fire. The footer status line is the only surface.
- Nothing added to the conversation: the line goes through `ctx.ui.setStatus` only. AC-10 and AC-12 of `pi-loop.md` hold unchanged.
- No fire count in the steady line, no seconds countdown. One line, pi theme colors only; no custom footer component.
- No persistence of the pulse: a restart inside the five seconds shows no pulse.
- No change to `/loop list`, the fire message, or the state files.

## Acceptance criteria
- AC-S1: While the owner session has loops, the footer reads `↻ <a> active, <p> paused · next <name> <HH:mm>`. `<name>` is the active loop with the earliest due time. `<a> active` is omitted when a is 0 and `<p> paused` when p is 0.
- AC-S2: For five seconds after a fire the `next` clause is replaced by `fired <name> #<fires>` under a `↯` glyph; the counts stay. A second fire inside the five seconds replaces the pulse. After five seconds the line returns to `next`.
- AC-S3: When an active loop is due and the session is not idle, the clause reads `due <name>` with no time.
- AC-S4: A non-owner session reads `⊘ <n> loop(s) · owned by pid <pid>`. The word `active` never appears there.
- AC-S5: When any loop has a last error the line ends with ` · <n> error` or ` · <n> errors`.
- AC-S6: With no loops the status is cleared (`setStatus(key, undefined)`). `/loop stop` of the loop whose pulse is showing drops the pulse. If the fired loop reached `--max` on that fire, the pulse still shows for five seconds, then the status clears.
- AC-S7: `setStatus` is called only when the rendered text changes. Ten idle ticks with nothing changing produce no call.
- AC-S8: `/loop` create, stop, pause, resume update the line in the same command, without waiting for a tick.
- AC-S9: Color comes from `ctx.ui.theme` roles. The glyph carries state: `success` steady, `warning` due, `accent` fired, `dim` when every loop is paused (`‖`), `muted` non-owner, `error` when any loop has a last error and no pulse is showing. Counts are `muted`, separators and times `dim`, the loop name `accent` (bold with the fired clause), the due clause `warning`, the error suffix `error`. Stripping color yields exactly the text in AC-S1..S5.

## Verification
- `cd ~/workspace/pi-loop && bun test` (AC-S1..AC-S9 against the mock pi host; every criterion has a named test)
- `grep -rn 'ctx\.ui\.\|session\.ctx\.ui\.' ~/workspace/pi-loop/extensions | grep -v 'notify\|setStatus\|theme' ; test $? -eq 1` (the only UI members used are notify, setStatus, theme)
- The AC-10 greps in `pi-loop.md`, unchanged
