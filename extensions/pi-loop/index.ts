// pi-loop: re-send one prompt on a fixed interval inside the current session.
//
// The only text this extension adds to the conversation is the fire itself,
// sent through pi.sendUserMessage as the trailing user message. Loop state
// lives in <cwd>/.pi-loop/loops.json and owner.json, never in the session.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { defaultName, parseCommand } from "./command.ts";
import { formatInterval } from "./interval.ts";
import { claimOwner, loadLoops, message, otherOwner, readPrompt, releaseOwner, saveLoops } from "./state.ts";
import type { Deps, Loop, LoopContext, LoopHost, WidgetTui } from "./types.ts";
import {
  detailPanel,
  displayFire,
  formatLoop,
  formatLocal,
  lineText,
  rosterLines,
  spaced,
  statusLine,
  statusWidget,
  type Line,
  type PanelAction,
  type Segment,
} from "./ui.ts";

export type { Deps, Loop, LoopContext, LoopHandler, LoopHost, MarkdownTransform, Panel, PromptSource } from "./types.ts";

const WIDGET_KEY = "pi-loop";
/** How long the status line says `fired <name> #<n>` after a fire. */
const PULSE_MS = 5000;

/** What one fireDue did: nothing, a state-file error, or a fire. */
type FireOutcome = { fired?: { name: string; fires: number }; error?: string };

interface Session {
  ctx: LoopContext;
  stopTicker: () => void;
  /** Last state-file error shown, so it is shown once until it changes. */
  reported?: string;
  /** The widget's text as last drawn, every line, so the screen is touched only on change. */
  status?: string;
  /** The lines the widget draws: the status line, the roster while it is open, or none while a loop's panel is open. */
  lines: Line[];
  /** The loops, their other owner, and the status line as of the last render; keys draw from these, never from the state file. */
  loops: Loop[];
  owner?: number;
  segments?: Segment[];
  /** The open roster and its selected loop, by name and last known row; undefined while collapsed to the status line. */
  roster?: { selected: string; index: number };
  /** A loop's detail panel, opened from the roster, has focus; keys are its own until it closes. */
  panelOpen?: boolean;
  /** Removes the terminal input listener; set in TUI mode only. */
  unsubscribe?: () => void;
  /** The registered widget's tui, through which every later change is redrawn; undefined while no widget is registered. */
  tui?: WidgetTui;
  /** The last fire, shown in the status line until `until`. */
  pulse?: { name: string; fires: number; until: number };
}

export default function piLoop(pi: ExtensionAPI): void {
  run(pi, realDeps());
}

export function run(pi: LoopHost, deps: Deps): void {
  /** The started session, if any. Set on session_start, cleared on session_shutdown. */
  let session: Session | undefined;

  /**
   * Fire the first due loop if the session is idle. A state-file error is
   * returned; a fire that skips records its error on the loop instead.
   */
  function fireDue(ctx: LoopContext): FireOutcome {
    const loaded = loadLoops(ctx.cwd);
    if (!loaded.ok) return { error: loaded.error };
    let loops = loaded.value;
    if (loops.length === 0) return {};
    if (!claimOwner(ctx, deps)) return {};
    const now = deps.now();

    // A loop past its --until is removed before any fire, even one due now.
    const expired = loops.filter((l) => l.until !== undefined && l.until <= now);
    if (expired.length > 0) {
      loops = loops.filter((l) => !expired.includes(l));
      saveLoops(ctx.cwd, loops);
      for (const l of expired) {
        if (l.until !== undefined) ctx.ui.notify(`${l.name} reached until ${formatLocal(l.until)}, removed`, "info");
      }
    }

    if (!ctx.isIdle()) return {};
    const due = loops.find((l) => !l.paused && l.dueAt <= now);
    if (!due) return {};
    due.dueAt = now + due.intervalMs;
    const prompt = readPrompt(ctx.cwd, due.prompt);
    if (!prompt.ok) {
      due.lastError = prompt.error;
      saveLoops(ctx.cwd, loops);
      return {};
    }
    delete due.lastError;
    due.fires += 1;
    const done = due.max !== undefined && due.fires >= due.max;
    // Save before send: a crash between the two loses one fire, never doubles it.
    saveLoops(ctx.cwd, done ? loops.filter((l) => l !== due) : loops);
    pi.sendUserMessage(`[loop ${due.name} #${due.fires} ${formatLocal(now)}]\n${prompt.value}`);
    if (done) ctx.ui.notify(`${due.name} reached max ${due.fires}, removed`, "info");
    return { fired: { name: due.name, fires: due.fires } };
  }

  /** One tick: fire what is due, notify a state-file error once until it changes, redraw the status line. */
  function tick(): void {
    if (!session) return;
    const outcome = fireDue(session.ctx);
    if (outcome.error !== session.reported) {
      session.reported = outcome.error;
      if (outcome.error) session.ctx.ui.notify(outcome.error, "error");
    }
    if (outcome.fired) session.pulse = { ...outcome.fired, until: deps.now() + PULSE_MS };
    render();
  }

  /** Read the state file, cache what the widget draws from, and draw it. */
  function render(): void {
    if (!session) return;
    const loaded = loadLoops(session.ctx.cwd);
    if (!loaded.ok) return;
    const now = deps.now();
    if (session.pulse && session.pulse.until <= now) session.pulse = undefined;
    session.loops = loaded.value;
    session.owner = otherOwner(session.ctx, deps);
    session.segments = statusLine(session.loops, session.owner, session.pulse, session.ctx.isIdle(), now);
    draw(session);
  }

  /**
   * Draw the status line, or the roster while it is open, from the last
   * render's cache, only when the text changes: register the widget when it
   * first has content, redraw it through its tui while it keeps content,
   * remove it when there is nothing to show. While a loop's panel is open the
   * widget stays registered and draws no lines, as pi-subagents' fleet line
   * does under its inspector. The roster closes when no loops
   * remain; a selected loop that is gone gives way to the row now at its
   * index, or the last row.
   */
  function draw(live: Session): void {
    const roster = live.roster;
    if (roster) {
      const at = live.loops.findIndex((l) => l.name === roster.selected);
      roster.index = at >= 0 ? at : Math.min(roster.index, live.loops.length - 1);
      const selected = live.loops[roster.index];
      if (selected) roster.selected = selected.name;
      else live.roster = undefined;
    }
    const lines = !live.segments
      ? undefined
      : live.panelOpen
        ? []
        : live.roster
          ? rosterLines(live.loops, live.owner, live.roster.index)
          : [spaced(live.segments)];
    const text = lines?.map(lineText).join("\n");
    if (text === live.status) return;
    live.status = text;
    if (!lines) {
      live.tui = undefined;
      live.ctx.ui.setWidget(WIDGET_KEY, undefined);
      return;
    }
    live.lines = lines;
    if (live.tui) {
      live.tui.requestRender();
    } else {
      live.ctx.ui.setWidget(
        WIDGET_KEY,
        (tui, theme) => {
          live.tui = tui;
          return statusWidget(() => live.lines, theme);
        },
        { placement: "belowEditor" },
      );
    }
  }

  /**
   * A terminal key, before the editor sees it. Collapsed, ↓ or ← on an empty,
   * focused editor with loops present opens the roster; every other key passes.
   * Open: ↓/j and ↑/k move, ↑/k on the first row and Esc collapse, and any other
   * key collapses and passes through; Enter opens the selected loop's panel,
   * and while it is open every key is the panel's. The cheap checks come first;
   * nothing here reads the state file.
   */
  function onKey(live: Session, data: string): { consume: true } | undefined {
    if (isKeyRelease(data) || live.panelOpen) return undefined;
    const roster = live.roster;
    if (!roster) {
      if (!matchesKey(data, "down") && !matchesKey(data, "left")) return undefined;
      const first = live.loops[0];
      if (!first || live.ctx.ui.getEditorText() !== "" || !editorHasFocus(live.tui)) return undefined;
      live.roster = { selected: first.name, index: 0 };
      draw(live);
      return { consume: true };
    }
    const collapse = () => {
      live.roster = undefined;
      draw(live);
    };
    if (!editorHasFocus(live.tui)) {
      collapse();
      return undefined;
    }
    const i = roster.index;
    const loop = live.loops[i];
    if (matchesKey(data, "enter") && loop) {
      openPanel(live, loop);
      return { consume: true };
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      roster.selected = live.loops[Math.min(i + 1, live.loops.length - 1)]?.name ?? roster.selected;
      draw(live);
      return { consume: true };
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (i === 0) collapse();
      else {
        roster.selected = live.loops[i - 1]?.name ?? roster.selected;
        draw(live);
      }
      return { consume: true };
    }
    if (matchesKey(data, "escape")) {
      collapse();
      return { consume: true };
    }
    collapse();
    return undefined;
  }

  /**
   * Open a loop's panel from the roster without waiting for it: the widget
   * draws nothing at once, keys pass to the panel until it closes, then the
   * roster is drawn again from the state file.
   * A session that ended meanwhile is left alone, since render draws only the
   * current one; a failure is logged.
   */
  function openPanel(live: Session, loop: Loop): void {
    live.panelOpen = true;
    draw(live);
    detail(live.ctx, loop, live.owner, () => session === live)
      .catch((e: unknown) => console.error(`pi-loop: ${message(e)}`))
      .finally(() => {
        live.panelOpen = false;
        safely(render);
      });
  }

  pi.on("session_start", (_event, ctx) => {
    session?.stopTicker();
    session?.unsubscribe?.();
    session = undefined;
    // TUI sessions only: the ticker, ownership, firing, the widget, and the key listener, loops or not.
    // Print, json, and RPC get no session whatever their hasUI (RPC has one), so a pi-subagents child
    // never fires; their /loop commands still write the state file for the TUI owner to fire.
    if (ctx.mode !== "tui") return;
    const live: Session = { ctx, stopTicker: deps.ticker(() => safely(tick)), lines: [], loops: [] };
    session = live;
    live.unsubscribe = ctx.ui.onTerminalInput((data) => onKey(live, data));
    render();
  });

  pi.on("agent_settled", () => {
    tick();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.stopTicker();
    session?.unsubscribe?.();
    if (session?.tui) session.ctx.ui.setWidget(WIDGET_KEY, undefined);
    session = undefined;
    releaseOwner(ctx, deps);
  });

  // A fire is stored as the plain bracket header plus the prompt (AC-1). On
  // screen only the header shows, as a heading; the prompt is the loop's own
  // text and repeating it every fire is noise.
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "user") return markdown;
    return displayFire(markdown);
  });

  pi.registerCommand("loop", {
    description: "Fire a prompt on an interval: /loop [--name n] [--max n] [--until t] <prompt with an interval: 5m, every 2 hours, hourly, daily>; /loop (or list) opens the roster; /loop stop | pause | resume <name>",
    handler: async (args, ctx) => {
      await handle(args, ctx);
      render();
    },
  });

  async function handle(args: string, ctx: LoopContext): Promise<void> {
    const now = deps.now();
    const parsed = parseCommand(args, now);
    if (!parsed.ok) {
      ctx.ui.notify(parsed.error, "error");
      return;
    }
    const loaded = loadLoops(ctx.cwd);
    if (!loaded.ok) {
      ctx.ui.notify(loaded.error, "error");
      return;
    }
    const loops = loaded.value;
    const cmd = parsed.value;

    // /loop and /loop list: the roster, on its first row, in the TUI; one text line per loop in every other
    // mode, RPC included, since only the TUI has the widget's keys. The command's render draws it.
    if (cmd.kind === "list") {
      const first = loops[0];
      if (ctx.mode === "tui" && first) {
        // A TUI session always has UI, so session_start has made one; missing, it is a bug to surface, not hide.
        if (!session) throw new Error("pi-loop: no session to open the roster in");
        session.roster = { selected: first.name, index: 0 };
        return;
      }
      const owner = otherOwner(ctx, deps);
      ctx.ui.notify(first ? loops.map((l) => formatLoop(l, owner)).join("\n") : "no loops", "info");
      return;
    }

    if (cmd.kind === "stop" || cmd.kind === "pause" || cmd.kind === "resume") {
      const loop = loops.find((l) => l.name === cmd.name);
      if (!loop) {
        ctx.ui.notify(`no loop named ${cmd.name}`, "error");
        return;
      }
      if (cmd.kind === "stop") {
        saveLoops(ctx.cwd, loops.filter((l) => l !== loop));
        if (session?.pulse?.name === loop.name) session.pulse = undefined;
        ctx.ui.notify(`stopped ${loop.name}`, "info");
        return;
      }
      if (cmd.kind === "pause") {
        if (loop.paused) {
          ctx.ui.notify(`${loop.name} is already paused`, "error");
          return;
        }
        loop.paused = true;
        saveLoops(ctx.cwd, loops);
        ctx.ui.notify(`paused ${loop.name}`, "info");
        return;
      }
      if (!loop.paused) {
        ctx.ui.notify(`${loop.name} is not paused`, "error");
        return;
      }
      loop.paused = false;
      loop.dueAt = now + loop.intervalMs;
      saveLoops(ctx.cwd, loops);
      ctx.ui.notify(`resumed ${loop.name}, next ${formatLocal(loop.dueAt)}`, "info");
      return;
    }

    if (cmd.kind === "create") {
      const name = cmd.name ?? defaultName(loops);
      if (loops.some((l) => l.name === name)) {
        ctx.ui.notify(`loop ${name} already exists`, "error");
        return;
      }
      const loop: Loop = {
        name,
        intervalMs: cmd.intervalMs,
        prompt: cmd.prompt,
        dueAt: now,
        fires: 0,
        paused: false,
        max: cmd.max,
        until: cmd.until,
      };
      loops.push(loop);
      saveLoops(ctx.cwd, loops);
      const owner = otherOwner(ctx, deps);
      ctx.ui.notify(`created ${name}, every ${formatInterval(loop.intervalMs)}${owner === undefined ? "" : `, owned by pid ${owner}`}`, "info");
      tick();
    }
  }

  /**
   * A loop's detail panel: p pauses or resumes, x asks and stops, escape or
   * ctrl+c goes back. Each action runs the typed command, only while `current`
   * still holds after the wait for the user.
   */
  async function detail(ctx: LoopContext, loop: Loop, owner: number | undefined, current: () => boolean): Promise<void> {
    const action = await ctx.ui.custom<PanelAction>((_tui, theme, keybindings, done) => detailPanel(loop, owner, theme, keybindings, done));
    if (!current()) return;
    if (action === "pause" || action === "resume") {
      await handle(`${action} ${loop.name}`, ctx);
    } else if (action === "stop") {
      const yes = await ctx.ui.confirm(`Stop ${loop.name}?`, "The loop is removed. Its fires so far stay in the transcript.");
      if (yes && current()) await handle(`stop ${loop.name}`, ctx);
    }
  }
}

/** The editor has focus when the focused component is shaped like pi's editor; a tui with no focus getter never has it. */
function editorHasFocus(tui: WidgetTui | undefined): boolean {
  const focused = tui?.getFocusedComponent?.();
  return (
    typeof focused === "object" &&
    focused !== null &&
    "render" in focused &&
    typeof focused.render === "function" &&
    "invalidate" in focused &&
    typeof focused.invalidate === "function" &&
    "handleInput" in focused &&
    typeof focused.handleInput === "function" &&
    "getText" in focused &&
    typeof focused.getText === "function" &&
    "setText" in focused &&
    typeof focused.setText === "function"
  );
}

/** Timer callbacks run outside pi's handler error path; never let one crash the process. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    console.error(`pi-loop: ${message(e)}`);
  }
}

function realDeps(): Deps {
  return {
    now: () => Date.now(),
    pid: process.pid,
    isPidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        // EPERM: alive but not ours. ESRCH: gone.
        return e instanceof Error && "code" in e && e.code === "EPERM";
      }
    },
    ticker: (fn) => {
      const id = setInterval(fn, 1000);
      id.unref();
      return () => clearInterval(id);
    },
  };
}
