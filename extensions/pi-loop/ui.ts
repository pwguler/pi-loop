// What the user sees: the footer status line, the picker rows, the loop's
// detail panel, the plain-text list line, and how a fire is drawn in the
// transcript. Everything here is display; nothing here touches state or the
// conversation.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatInterval } from "./interval.ts";
import type { Loop, Panel } from "./types.ts";

type Color = Parameters<Theme["fg"]>[0];

interface Segment {
  text: string;
  color: Color;
  bold?: boolean;
}

const SEP: Segment = { text: "\u00b7", color: "dim" };

/**
 * The footer status line as colored segments, or undefined to clear it. The
 * count carries the state color; there is no glyph.
 * Owner:     2 active, 1 paused · next fast 10:05 | ... · due fast | ... · fired fast #6 [· 1 error]
 * Paused:    1 paused
 * Non-owner: 2 loops · owned by pid 4242
 */
export function statusLine(
  loops: Loop[],
  owner: number | undefined,
  pulse: { name: string; fires: number } | undefined,
  idle: boolean,
  now: number,
): Segment[] | undefined {
  if (loops.length === 0) {
    if (!pulse) return undefined;
    return [{ text: `fired ${pulse.name} #${pulse.fires}`, color: "accent", bold: true }];
  }
  if (owner !== undefined) {
    return [
      { text: `${loops.length} loop${loops.length === 1 ? "" : "s"}`, color: "muted" },
      SEP,
      { text: `owned by pid ${owner}`, color: "muted" },
    ];
  }
  const active = loops.filter((l) => !l.paused);
  const paused = loops.length - active.length;
  const errors = loops.filter((l) => l.lastError !== undefined).length;
  const next = active.reduce<Loop | undefined>((a, l) => (a === undefined || l.dueAt < a.dueAt ? l : a), undefined);
  const due = next !== undefined && next.dueAt <= now && !idle;

  const counts: string[] = [];
  if (active.length > 0) counts.push(`${active.length} active`);
  if (paused > 0) counts.push(`${paused} paused`);
  const count = counts.join(", ");

  const out: Segment[] = [];
  if (pulse) {
    out.push({ text: count, color: "accent" }, SEP, { text: `fired ${pulse.name} #${pulse.fires}`, color: "accent", bold: true });
  } else if (next === undefined) {
    out.push({ text: count, color: "dim" });
  } else if (due) {
    out.push({ text: count, color: "warning" }, SEP, { text: `due ${next.name}`, color: "warning" });
  } else {
    out.push({ text: count, color: "success" }, SEP);
    out.push({ text: "next", color: "muted" }, { text: next.name, color: "accent" }, { text: formatLocal(next.dueAt).slice(11), color: "dim" });
  }
  if (errors > 0) out.push(SEP, { text: `${errors} error${errors === 1 ? "" : "s"}`, color: "error" });
  return out;
}

export function paint(segments: Segment[], theme: Pick<Theme, "fg" | "bold">): string {
  return segments
    .map((s) => {
      const colored = theme.fg(s.color, s.text);
      return s.bold ? theme.bold(colored) : colored;
    })
    .join(" ");
}

/** One picker row: name, status, next, interval, fires. */
export function pickerRow(loop: Loop, owner: number | undefined): string {
  const next = loop.paused ? "-" : formatLocal(loop.dueAt).slice(11);
  return [loop.name.padEnd(10), loopStatus(loop, owner).padEnd(7), `next ${next.padEnd(5)}`, `every ${formatInterval(loop.intervalMs)}`, `#${loop.fires}`].join("  ");
}

function loopStatus(loop: Loop, owner: number | undefined): string {
  return loop.paused ? "paused" : owner === undefined ? "active" : `owned by pid ${owner}`;
}

/** One /loop list line: name, status, next due, interval, count, bounds, last error. */
export function formatLoop(loop: Loop, owner: number | undefined): string {
  const parts = [
    loop.name,
    loopStatus(loop, owner),
    `next ${loop.paused ? "-" : formatLocal(loop.dueAt)}`,
    `every ${formatInterval(loop.intervalMs)}`,
    `fires ${loop.fires}`,
  ];
  if (loop.max !== undefined) parts.push(`max ${loop.max}`);
  if (loop.until !== undefined) parts.push(`until ${formatLocal(loop.until)}`);
  if (loop.lastError !== undefined) parts.push(`error: ${loop.lastError}`);
  return parts.join("  ");
}

export function formatLocal(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export type PanelAction = "pause" | "resume" | "stop" | "back";

/**
 * The loop's detail panel, drawn like pi's selector: border, blank, title,
 * blank, body, blank, hint line, blank, border. Single keys act.
 */
export function detailPanel(
  loop: Loop,
  owner: number | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  keybindings: { matches(data: string, id: "tui.select.cancel"): boolean },
  done: (action: PanelAction) => void,
): Panel {
  const toggle = loop.paused ? "resume" : "pause";
  const field = (label: string, value: string) => ` ${theme.fg("muted", label.padEnd(10))} ${value}`;
  const hint = (key: string, text: string) => theme.fg("dim", key) + theme.fg("muted", ` ${text}`);
  const body = [
    field("interval", formatInterval(loop.intervalMs)),
    field("prompt", loop.prompt.kind === "text" ? loop.prompt.text : `@${loop.prompt.path}`),
    field("next", loop.paused ? "-" : formatLocal(loop.dueAt)),
    field("fires", String(loop.fires)),
    field("status", loopStatus(loop, owner)),
  ];
  if (loop.max !== undefined) body.push(field("max", String(loop.max)));
  if (loop.until !== undefined) body.push(field("until", formatLocal(loop.until)));
  if (loop.lastError !== undefined) body.push(field("error", loop.lastError));
  return {
    render(width) {
      const border = theme.fg("border", "\u2500".repeat(Math.max(1, width)));
      return [
        border,
        "",
        ` ${theme.fg("accent", theme.bold(loop.name))}`,
        "",
        ...body,
        "",
        ` ${hint("p", toggle)}  ${hint("x", "stop")}  ${hint("escape/ctrl+c", "back")}`,
        "",
        border,
      ];
    },
    handleInput(data) {
      if (data === "p") done(toggle);
      else if (data === "x") done("stop");
      else if (keybindings.matches(data, "tui.select.cancel")) done("back");
    },
    invalidate() {},
  };
}

/** A fire as sent: the header line [loop <name> #<n> <YYYY-MM-DD HH:mm>], then the prompt. */
const FIRE_MESSAGE = /^\[loop ([A-Za-z0-9][A-Za-z0-9._-]*) #(\d+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n[\s\S]*$/;

/**
 * How a fire is drawn in the transcript: the header line as a level-2 heading
 * (pi draws it in the heading color with no marker), the prompt not repeated.
 * Display only; the stored message and what the model sees are unchanged.
 */
export function displayFire(markdown: string): string {
  return markdown.replace(FIRE_MESSAGE, "## $1 #$2 \u00b7 $3");
}
