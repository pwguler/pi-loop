# pi-loop

## Goal
A pi extension that re-sends a prompt on a fixed interval inside the current session, persists across pi restarts, and never touches any byte of the prompt except the trailing user message it sends.

## Non-goals
- No goals, lists, audits, measure commands, plateau detection, or completion verdicts. The loop fires; what "done" means is the prompt's business.
- No active-hours window, no timezone logic. A loop fires on its interval around the clock; any rest logic belongs in the prompt.
- No modification of the system prompt, no `context` hook, no message injected anywhere but the tail, no `cache_control` markers, no TTL settings. Anything before the last message is left byte-identical.
- No external scheduler. No cron, no systemd, no spawned `pi -p`. The timer lives in the extension.
- No ledger, no metrics file, no dashboard. The session transcript is the record. A one-line footer status is not a dashboard; it is specified in `pi-loop-status.md`.
- No npm publish. Installed from the local directory.
- No `pi -p` support. Interactive sessions only.

## Acceptance criteria
- AC-1: `/loop <text with an interval phrase>` creates a loop and fires it immediately as one normal trailing user message whose first line is `[loop <name> #1 <YYYY-MM-DD HH:mm>]`, followed by the prompt text with the interval phrase cut out. The phrase may lead or trail the text in any form (`5m`, `5 min`, `every 2 hours`, `hourly`, `daily`, `1h30m`, `1 hour 30 minutes`); in the middle of the text only an `every`/`each` phrase counts, so a duration inside the instruction is never eaten. Minimum `1m`. No phrase, two phrases, or a phrase below the minimum rejects with an error and creates nothing.
- AC-2: Each next fire is due at `lastFiredAt + interval` and fires only when the session is idle. A tick that becomes due while the agent is busy fires once when the agent settles, never twice, and the next due time counts from that actual fire.
- AC-3: A prompt argument starting with `@` is a file path re-read at every fire. Editing the file between fires changes the next fire's text without recreating the loop. A missing file at fire time skips that fire, records the error in `/loop list`, and keeps the loop alive.
- AC-4: State lives in `<cwd>/.pi-loop/loops.json`. After the process exits and a new session starts in the same cwd, every non-stopped loop resumes with its counter, prompt, interval, and bounds intact.
- AC-5: On resume, a loop whose due time has passed fires once at the first idle moment, then continues on its interval from that fire. Multiple missed ticks collapse into that one fire.
- AC-6: `<cwd>/.pi-loop/owner.json` holds `{pid, sessionId, claimedAt}`. Only the owner session fires. A second session in the same cwd fires nothing and shows `owned by pid <n>` in `/loop list`. A session whose recorded pid is not alive is taken over by the next session that starts. On owner shutdown the file is removed.
- AC-7: The loop listing shows for each loop: name, interval, next due (local time), iteration count, status (`active`, `paused`, `owned by pid n`), last error if any. `/loop stop <name>` removes the loop. `/loop pause <name>` and `/loop resume <name>` toggle firing and keep the counter; resume counts the next due from the resume moment. `/loop list` and bare `/loop` open the picker in `pi-loop-picker.md`; without a UI both print the lines above.
- AC-8: `--name <n>` sets the loop name; default is `loop-<k>` with the lowest free k. Creating a loop with an existing name rejects with an error. Flags sit at the head or the tail of the text, never inside the prompt.
- AC-9: `--max <n>` stops the loop after its n-th fire. `--until <ISO datetime or HH:mm>` stops the loop at that time. Either bound reached removes the loop and prints one line to the UI. Both are optional; without them the loop runs until `/loop stop`.
- AC-10: The extension source contains no `cache_control`, no `ttl`, no `pi.on("context"`, no `systemPrompt`, and calls `pi.sendUserMessage` as the only path that adds text to the conversation.
- AC-11: Across one fire in a live session with the pengepul relay, `cacheRead` on the fire turn is at least 90% of the previous turn's `cacheRead + cacheWrite`. Full rewrites do not occur at fire boundaries.
- AC-12: Session compaction between two fires does not change the loop's counter, due time, or prompt. Loop state is never read from conversation history.
- AC-13: `pi install ~/workspace/pi-loop` registers the extension; `pi list` shows it; `/loop` is available in a fresh session.

## Verification
- `cd ~/workspace/pi-loop && bun test` (AC-1..AC-9, AC-12 against a mock pi context; every criterion has a named test)
- `grep -rnE 'cache_control|"ttl"|\bttl\s*[:=]|pi\.on\("context"|systemPrompt' ~/workspace/pi-loop/extensions ; test $? -eq 1` (AC-10)
- `grep -rn 'sendUserMessage\|sendMessage' ~/workspace/pi-loop/extensions | grep -v sendUserMessage ; test $? -eq 1` (AC-10)
- `pi install ~/workspace/pi-loop && pi list | grep pi-loop` (AC-13)
- Live: start a `2m` loop in a session on the relay, wait two fires, run `python3 usage.py <session.jsonl>`; the two fire turns show no rewrite flag (AC-11)
