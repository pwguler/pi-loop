// What the user sees: the status line below the editor, the roster it opens into, the loop's
// detail panel, the plain-text list line, and how a fire is drawn in the
// transcript. Everything here is display; nothing here touches state or the
// conversation.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type KeyId } from "@earendil-works/pi-tui";
import { formatInterval } from "./interval.ts";
import type { Loop, Panel } from "./types.ts";

type Color = Parameters<Theme["fg"]>[0];

export interface Segment {
  text: string;
  /** No color: drawn in the default text color, with no theme call. */
  color?: Color;
}

/** One widget line: its segments drawn side by side. */
export type Line = Segment[];

/** The shortcut that opens the roster and, while it is open, closes it. */
export const ROSTER_KEY: KeyId = "alt+l";

const HINT = `${ROSTER_KEY} to manage`;

/**
 * The status line as segments, or undefined when there is no line: a muted
 * label, a plain " · " joiner, and one dim detail that carries its own
 * separators and the hint; no glyph, nothing bold.
 * Owner:     2 active loops, 1 paused · next fast 10:05 | ... · due fast | ... · fired fast #6 [· 1 error] · alt+l to manage
 * Paused:    1 paused loop · alt+l to manage
 * Non-owner: 2 loops · owned by pid 4242 · alt+l to manage
 * No loops, just fired: fired fast #3 (the label alone)
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
    return [{ text: `fired ${pulse.name} #${pulse.fires}`, color: "muted" }];
  }
  if (owner !== undefined) {
    return line(plural(loops.length, "loop"), [`owned by pid ${owner}`, HINT]);
  }
  const active = loops.filter((l) => !l.paused);
  const paused = loops.length - active.length;
  const errors = loops.filter((l) => l.lastError !== undefined).length;
  const next = active.reduce<Loop | undefined>((a, l) => (a === undefined || l.dueAt < a.dueAt ? l : a), undefined);
  const due = next !== undefined && next.dueAt <= now && !idle;

  const count =
    active.length === 0
      ? plural(paused, "paused loop")
      : `${plural(active.length, "active loop")}${paused > 0 ? `, ${paused} paused` : ""}`;

  const parts: string[] = [];
  if (pulse) parts.push(`fired ${pulse.name} #${pulse.fires}`);
  else if (next !== undefined) parts.push(due ? `due ${next.name}` : `next ${next.name} ${formatLocal(next.dueAt).slice(11)}`);
  if (errors > 0) parts.push(plural(errors, "error"));
  parts.push(HINT);
  return line(count, parts);
}

function line(label: string, detail: string[]): Segment[] {
  return [{ text: label, color: "muted" }, { text: " \u00b7 " }, { text: detail.join(" \u00b7 "), color: "dim" }];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** A line's text without color: what change detection compares. */
export function lineText(line: Line): string {
  return line.map((s) => s.text).join("");
}

function paint(line: Line, theme: Pick<Theme, "fg">): string {
  return line
    .map((s) => (s.color === undefined ? s.text : theme.fg(s.color, s.text)))
    .join("");
}

/** The widget below the editor: the status line or the roster, each line indented two spaces and cut to the width it is given. */
export function statusWidget(lines: () => Line[], theme: Pick<Theme, "fg">): Panel {
  return {
    render(width) {
      return lines().map((line) => truncateToWidth(`  ${paint(line, theme)}`, width));
    },
    invalidate() {},
  };
}

/** Most loop rows the roster shows at once. */
const ROSTER_ROWS = 8;

/** The roster's name column: as wide as the longest name, within these bounds; a longer name is cut to fit, ending in …. */
const NAME_MIN = 10;
const NAME_MAX = 16;

/** The roster's status column is as wide as the longest status, at least this. */
const STATUS_MIN = 7;

/**
 * The roster: the header, then one row per loop with the selected one marked,
 * at most ROSTER_ROWS of them, the window scrolled to keep the selection in view.
 * Columns are sized over every loop, not the window, so they hold still while scrolling.
 */
export function rosterLines(loops: Loop[], owner: number | undefined, selected: number): Line[] {
  const start = Math.max(0, selected - ROSTER_ROWS + 1);
  const widths = {
    name: Math.min(NAME_MAX, Math.max(NAME_MIN, ...loops.map((l) => l.name.length))),
    status: Math.max(STATUS_MIN, ...loops.map((l) => loopStatus(l, owner).length)),
  };
  const header: Line = [{ text: "loops", color: "muted" }, { text: " " }, { text: "\u00b7 \u2191\u2193/jk select \u00b7 p pause \u00b7 r resume \u00b7 enter open \u00b7 esc back", color: "dim" }];
  const rows = loops.slice(start, start + ROSTER_ROWS).map((loop, i): Line => {
    const marker: Segment = start + i === selected ? { text: "\u203a", color: "accent" } : { text: " " };
    return [marker, { text: " " }, ...rosterRow(loop, owner, widths)];
  });
  return [header, ...rows];
}

/** One roster row: name, status, next, interval, fires; only the status word is colored. */
function rosterRow(loop: Loop, owner: number | undefined, widths: { name: number; status: number }): Line {
  const next = loop.paused ? "-" : formatLocal(loop.dueAt).slice(11);
  const status = loopStatus(loop, owner);
  const color: Color = loop.paused ? "dim" : owner === undefined ? "success" : "muted";
  const name = loop.name.length > NAME_MAX ? `${loop.name.slice(0, NAME_MAX - 1)}\u2026` : loop.name;
  const rest = [`next ${next.padEnd(5)}`, `every ${formatInterval(loop.intervalMs)}`, `#${loop.fires}`].join("  ");
  return [{ text: `${name.padEnd(widths.name)}  ` }, { text: status, color }, { text: `${" ".repeat(widths.status - status.length)}  ${rest}` }];
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
 * blank, body, blank, hint line, blank, border. Single keys act: p pauses an
 * active loop, r resumes a paused one; the key that does not apply does nothing.
 */
export function detailPanel(
  loop: Loop,
  owner: number | undefined,
  theme: Pick<Theme, "fg" | "bold">,
  keybindings: { matches(data: string, id: "tui.select.cancel"): boolean },
  done: (action: PanelAction) => void,
): Panel {
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
        ` ${hint("p", "pause")}  ${hint("r", "resume")}  ${hint("x", "stop")}  ${hint("escape/ctrl+c", "back")}`,
        "",
        border,
      ];
    },
    handleInput(data) {
      if (data === "p" && !loop.paused) done("pause");
      else if (data === "r" && loop.paused) done("resume");
      else if (data === "x") done("stop");
      else if (keybindings.matches(data, "tui.select.cancel")) done("back");
    },
    invalidate() {},
  };
}

/** A fire as sent: the header line [loop <name> #<n> <YYYY-MM-DD HH:mm>], then the prompt. */
const FIRE_MESSAGE = /^\[loop ([A-Za-z0-9][A-Za-z0-9._-]*) #(\d+) (\d{4}-\d{2}-\d{2} \d{2}:\d{2})\]\n[\s\S]*$/;

/**
 * How a fire is drawn in the transcript: the header line as a plain line
 * (no heading markup, so no heading color), the prompt not repeated.
 * Display only; the stored message and what the model sees are unchanged.
 */
export function displayFire(markdown: string): string {
  return markdown.replace(FIRE_MESSAGE, "$1 #$2 \u00b7 $3");
}
