// pi-loop: re-send one prompt on a fixed interval inside the current session.
//
// The only text this extension adds to the conversation is the fire itself,
// sent through pi.sendUserMessage as the trailing user message. Loop state
// lives in <cwd>/.pi-loop/loops.json and owner.json, never in the session.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { defaultName, parseCommand } from "./command.ts";
import { formatInterval } from "./interval.ts";
import { claimOwner, loadLoops, message, otherOwner, readPrompt, releaseOwner, saveLoops } from "./state.ts";
import type { Deps, Loop, LoopContext, LoopHost } from "./types.ts";
import { detailPanel, displayFire, formatLoop, formatLocal, paint, pickerRow, statusLine, type PanelAction } from "./ui.ts";

export type { Deps, Loop, LoopContext, LoopHandler, LoopHost, MarkdownTransform, Panel, PromptSource } from "./types.ts";

const STATUS_KEY = "pi-loop";
/** How long the footer says `fired <name> #<n>` after a fire. */
const PULSE_MS = 5000;

/** What one fireDue did: nothing, a state-file error, or a fire. */
type FireOutcome = { fired?: { name: string; fires: number }; error?: string };

interface Session {
  ctx: LoopContext;
  stopTicker: () => void;
  /** Last state-file error shown, so it is shown once until it changes. */
  reported?: string;
  /** The status line as last rendered, so setStatus is called only on change. */
  status?: string;
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

  /** Redraw the footer status line; setStatus is called only when the text changes. */
  function render(): void {
    if (!session) return;
    const loaded = loadLoops(session.ctx.cwd);
    if (!loaded.ok) return;
    const now = deps.now();
    if (session.pulse && session.pulse.until <= now) session.pulse = undefined;
    const segments = statusLine(loaded.value, otherOwner(session.ctx, deps), session.pulse, session.ctx.isIdle(), now);
    const text = segments?.map((s) => s.text).join(" ");
    if (text === session.status) return;
    session.status = text;
    session.ctx.ui.setStatus(STATUS_KEY, segments && paint(segments, session.ctx.ui.theme));
  }

  pi.on("session_start", (_event, ctx) => {
    session?.stopTicker();
    session = undefined;
    // Interactive sessions only. A -p run has no UI and must not fire loops.
    if (!ctx.hasUI) return;
    session = { ctx, stopTicker: deps.ticker(() => safely(tick)) };
    render();
  });

  pi.on("agent_settled", () => {
    tick();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.stopTicker();
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
    description: "Fire a prompt on an interval: /loop [--name n] [--max n] [--until t] <prompt with an interval: 5m, every 2 hours, hourly, daily>; /loop (or list) picks a loop; /loop stop | pause | resume <name>",
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

    // /loop and /loop list: the picker where there is a UI, one text line per loop where there is not.
    if (cmd.kind === "list") {
      if (ctx.hasUI) {
        await picker(ctx);
        return;
      }
      const owner = otherOwner(ctx, deps);
      ctx.ui.notify(loops.length === 0 ? "no loops" : loops.map((l) => formatLoop(l, owner)).join("\n"), "info");
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
   * /loop and /loop list in a UI session: pi's built-in picker for the list;
   * Enter opens the loop's detail panel, where p pauses or resumes, x stops,
   * escape or ctrl+c goes back. Every action runs the typed command, so the
   * state file, the notice, and the footer update the same way.
   */
  async function picker(ctx: LoopContext): Promise<void> {
    for (;;) {
      const loaded = loadLoops(ctx.cwd);
      if (!loaded.ok) {
        ctx.ui.notify(loaded.error, "error");
        return;
      }
      const loops = loaded.value;
      const owner = otherOwner(ctx, deps);
      const rows = loops.map((l) => pickerRow(l, owner));
      const picked = await ctx.ui.select("loops", rows.length === 0 ? ["no loops"] : rows);
      const loop = picked === undefined ? undefined : loops[rows.indexOf(picked)];
      if (!loop) return;

      const action = await ctx.ui.custom<PanelAction>((_tui, theme, keybindings, done) => detailPanel(loop, owner, theme, keybindings, done));
      if (action === "pause" || action === "resume") {
        await handle(`${action} ${loop.name}`, ctx);
      } else if (action === "stop") {
        const yes = await ctx.ui.confirm(`Stop ${loop.name}?`, "The loop is removed. Its fires so far stay in the transcript.");
        if (yes) await handle(`stop ${loop.name}`, ctx);
      }
    }
  }
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
