# pi-loop-picker

## Goal
Bare `/loop` and `/loop list` open pi's built-in picker: one row per loop, Enter shows that loop's detail with pause or resume, stop, and back; Esc closes.

## Non-goals
- No custom TUI component. Both screens are `ctx.ui.select`; stop confirms through `ctx.ui.confirm`.
- No new mutation path. Pause, resume, stop from the picker run the same code as the typed commands, so the state file, the notice, and the footer update the same way.
- A session without a UI gets plain text, one line per loop, for both forms. There is no way to get the text in a UI session.
- No prompt editing.

## Acceptance criteria
- AC-P1: Bare `/loop` and `/loop list` in a UI session open the same picker titled `loops` with one row per loop: `<name>  <status>  next <HH:mm or ->  every <interval>  #<fires>`. Status is `active`, `paused`, or `owned by pid <n>`. No loops: one row `no loops`, Enter or Esc closes.
- AC-P2: Esc on the list closes the picker and writes nothing.
- AC-P3: Enter on a row opens a second picker whose title is the loop's detail, one field per line: `name`, `interval`, `prompt` (text, or `@<path>`), `next`, `fires`, `status`, and when set `max`, `until`, `error`. Its rows are `pause` (or `resume` when paused), `stop`, `back`.
- AC-P4: `pause` and `resume` apply immediately, print the same notice as the typed command, and return to the list showing the new status.
- AC-P5: `stop` asks `Stop <name>?`; yes removes the loop and returns to the list, no returns to the list with nothing changed.
- AC-P6: `back` and Esc on the detail return to the list. With no UI, both forms print one line per loop: name, status, next due (local time), interval, fires, bounds, last error.

## Verification
- `cd ~/workspace/pi-loop && bun test` (AC-P1..AC-P6 against the mock pi host with scripted select and confirm)
- `grep -rn 'ctx\.ui\.\|session\.ctx\.ui\.' ~/workspace/pi-loop/extensions | grep -v 'notify\|setStatus\|theme\|select\|confirm' ; test $? -eq 1`
- The AC-10 greps in `pi-loop.md`, unchanged
