# pi-loop-picker

## Goal
Bare `/loop` and `/loop list` open pi's built-in picker: one row per loop, Enter shows that loop's detail panel where single keys pause or resume, stop, and go back; Esc closes.

## Non-goals
- The list is `ctx.ui.select`. The detail is one `ctx.ui.custom` panel drawn with the same border, spacing, and hint style as pi's selector, so it reads as the same dialog. Stop confirms through `ctx.ui.confirm`.
- No new mutation path. Pause, resume, stop from the picker run the same code as the typed commands, so the state file, the notice, and the footer update the same way.
- A session without a UI gets plain text, one line per loop, for both forms. There is no way to get the text in a UI session.
- No prompt editing.

## Acceptance criteria
- AC-P1: Bare `/loop` and `/loop list` in a UI session open the same picker titled `loops` with one row per loop: `<name>  <status>  next <HH:mm or ->  every <interval>  #<fires>`. Status is `active`, `paused`, or `owned by pid <n>`. No loops: one row `no loops`, Enter or Esc closes.
- AC-P2: Esc on the list closes the picker and writes nothing.
- AC-P3: Enter on a row opens the loop's detail panel: a border, the name as title, one field per line (`interval`, `prompt` as text or `@<path>`, `next`, `fires`, `status`, and when set `max`, `until`, `error`), then the hint line `p pause  x stop  escape/ctrl+c back` (`p resume` when paused), then a border. Keys and descriptions use the dim and muted roles like pi's own hints.
- AC-P4: `p` pauses (or resumes) at once, prints the same notice as the typed command, and returns to the list showing the new status.
- AC-P5: `x` asks `Stop <name>?`; yes removes the loop and returns to the list, no returns to the list with nothing changed.
- AC-P6: Esc and ctrl+c on the detail return to the list; any other key is ignored. With no UI, both forms print one line per loop: name, status, next due (local time), interval, fires, bounds, last error.

## Verification
- `cd ~/workspace/pi-loop && bun test` (AC-P1..AC-P6 against the mock pi host with scripted select and confirm)
- `grep -rn 'ctx\.ui\.\|session\.ctx\.ui\.' ~/workspace/pi-loop/extensions | grep -v 'notify\|setStatus\|theme\|select\|confirm\|custom' ; test $? -eq 1`
- The AC-10 greps in `pi-loop.md`, unchanged
