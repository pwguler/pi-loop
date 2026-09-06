# pi-loop

A pi extension that re-sends one prompt on a fixed interval inside the current session. It exists because a recurring prompt should survive a dropped connection and cost one tail message per fire, nothing more.

## Language

**Loop**:
A named recurring prompt with an interval and optional bounds.
_Avoid_: goal, job, cron, schedule

**Fire**:
One delivery of the loop's prompt as the trailing user message of the session.
_Avoid_: wake, tick, iteration, run

**Due**:
The instant `lastFiredAt + interval`, at which the next fire may happen.
_Avoid_: scheduled, deadline

**Interval**:
The fixed duration between one fire and the next, counted from the fire itself, not from when the turn finished.
_Avoid_: cadence, period, frequency

**Paused**:
A loop the user halted with `/loop pause`; it keeps its counter and fires nothing until resumed.
_Avoid_: stopped, suspended, sleeping

**Catch-up**:
The single fire a loop performs when it is due on resume, no matter how many fires were missed.
_Avoid_: replay, backfill

**Owner**:
The one pi session in a workspace allowed to fire loops, recorded by pid and session id.
_Avoid_: leader, master, primary

**Bound**:
A `--max` fire count or `--until` time that removes the loop when reached.
_Avoid_: limit, budget, stop condition

**Prompt source**:
Either literal text stored with the loop or a file path re-read at every fire.
_Avoid_: spec, template, message

**Status line**:
The one line in pi's footer that summarizes every loop in the workspace and, briefly, the last fire.
_Avoid_: dashboard, widget, indicator

## Relationships

- A **Loop** has exactly one **Prompt source**, one **Interval**, and at most two **Bounds**
- A **Loop** performs zero or more **Fires**; the count of **Fires** is the loop's iteration number
- A **Fire** happens only when the loop is **Due**, the session is idle, and the session is the **Owner**
- A **Paused** loop is never **Due**; on resume its next **Due** is counted from the resume moment
- The **Status line** summarizes every **Loop** and shows the most recent **Fire** for five seconds

## Example dialogue

> **Dev:** "The loop is 50m, last fire 14:00, pi died at 14:10, I came back at 16:30. Do I get three fires?"
> **Owner:** "One. That is a catch-up. Next due is 17:20, counted from the catch-up fire, not from 14:00."
>
> **Dev:** "Second pane opens pi in the same folder. Does it also fire?"
> **Owner:** "No. The first session is the owner. The second pane lists the loop as owned by that pid and does nothing. If the owner pid is dead, the second pane takes over."
>
> **Dev:** "I want it quiet at night."
> **Owner:** "Put that in the prompt. The loop fires on its interval, day or night."

## Flagged ambiguities

- "iteration" was used in GLLA for both the fire and the counter. Here **Fire** is the event, and the iteration number is just the count of fires; there is no separate concept.
- "active hours" was proposed and cut. The loop has no clock awareness beyond its interval; rest behavior is the prompt's job.
