// pi-loop: re-send one prompt on a fixed interval inside the current session.
//
// The only text this extension adds to the conversation is the fire itself,
// sent through pi.sendUserMessage as the trailing user message. Loop state
// lives in <cwd>/.pi-loop/loops.json and owner.json, never in the session.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_DIR = ".pi-loop";
const MIN_INTERVAL_MS = 60_000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The narrow slice of pi's API this extension uses. The default export is
// typed against ExtensionAPI, so tsc checks that pi still satisfies it.

export interface LoopContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  isIdle(): boolean;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

export type LoopHandler = (event: unknown, ctx: LoopContext) => void;

export interface LoopHost {
  on(event: "session_start" | "session_shutdown" | "agent_settled", handler: LoopHandler): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: LoopContext) => Promise<void> },
  ): void;
  sendUserMessage(text: string): void;
}

/** Time and process seams, injected so tests drive them. */
export interface Deps {
  now(): number;
  pid: number;
  isPidAlive(pid: number): boolean;
  /** Start a periodic tick; returns the stop function. */
  ticker(fn: () => void): () => void;
}

export type PromptSource = { kind: "text"; text: string } | { kind: "file"; path: string };

export interface Loop {
  name: string;
  interval: string;
  prompt: PromptSource;
  /** Instant at which the next fire may happen. */
  dueAt: number;
  /** Count of fires performed so far. */
  fires: number;
  paused: boolean;
  /** Bound: remove after this many fires. */
  max?: number;
  /** Bound: remove at this instant. */
  until?: number;
  lastError?: string;
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export default function piLoop(pi: ExtensionAPI): void {
  run(pi, realDeps());
}

export function run(pi: LoopHost, deps: Deps): void {
  /** The started session, if any. Set on session_start, cleared on session_shutdown. */
  let session: { ctx: LoopContext; stopTicker: () => void; reported?: string } | undefined;

  /**
   * Fire the first due loop if the session is idle. Returns an error message
   * when the state file is unreadable; a fire that skips records its error on
   * the loop instead.
   */
  function fireDue(ctx: LoopContext): string | undefined {
    const loaded = loadLoops(ctx.cwd);
    if (!loaded.ok) return loaded.error;
    const loops = loaded.value;
    if (loops.length === 0) return undefined;
    if (!claimOwner(ctx, deps)) return undefined;
    if (!ctx.isIdle()) return undefined;
    const now = deps.now();
    const due = loops.find((l) => !l.paused && l.dueAt <= now);
    if (!due) return undefined;
    const intervalMs = parseInterval(due.interval) ?? MIN_INTERVAL_MS;
    due.dueAt = now + intervalMs;
    const prompt = readPrompt(ctx.cwd, due.prompt);
    if (!prompt.ok) {
      due.lastError = prompt.error;
      saveLoops(ctx.cwd, loops);
      return undefined;
    }
    delete due.lastError;
    due.fires += 1;
    saveLoops(ctx.cwd, loops);
    pi.sendUserMessage(`[loop ${due.name} #${due.fires} ${formatLocal(now)}]\n${prompt.value}`);
    return undefined;
  }

  /** One tick: fire what is due, and notify a state-file error once until it changes. */
  function tick(): void {
    if (!session) return;
    const error = fireDue(session.ctx);
    if (error !== session.reported) {
      session.reported = error;
      if (error) session.ctx.ui.notify(error, "error");
    }
  }

  pi.on("session_start", (_event, ctx) => {
    session?.stopTicker();
    session = undefined;
    // Interactive sessions only. A -p run has no UI and must not fire loops.
    if (!ctx.hasUI) return;
    session = { ctx, stopTicker: deps.ticker(() => safely(tick)) };
  });

  pi.on("agent_settled", () => {
    tick();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.stopTicker();
    session = undefined;
    releaseOwner(ctx, deps);
  });

  pi.registerCommand("loop", {
    description: "Fire a prompt on an interval: /loop <5m|2h|1d> [--name n] [--max n] [--until t] <prompt | @file>; /loop list | stop | pause | resume <name>",
    handler: async (args, ctx) => {
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

      if (cmd.kind === "list") {
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
        loop.dueAt = now + (parseInterval(loop.interval) ?? MIN_INTERVAL_MS);
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
          interval: cmd.interval,
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
        ctx.ui.notify(`created ${name}, every ${cmd.interval}${owner === undefined ? "" : `, owned by pid ${owner}`}`, "info");
        tick();
      }
    },
  });
}

// Command parsing

type Command =
  | { kind: "list" }
  | { kind: "stop" | "pause" | "resume"; name: string }
  | { kind: "create"; interval: string; prompt: PromptSource; name?: string; max?: number; until?: number };

function parseCommand(args: string, now: number): Result<Command> {
  const [head, rest] = nextToken(args);
  if (head === "" || head === "list") return { ok: true, value: { kind: "list" } };
  if (head === "stop" || head === "pause" || head === "resume") {
    const [name, extra] = nextToken(rest);
    if (name === "" || extra.trim() !== "") return { ok: false, error: `usage: /loop ${head} <name>` };
    return { ok: true, value: { kind: head, name } };
  }

  const usage = "usage: /loop <5m|2h|1d> [--name <n>] [--max <n>] [--until <ISO|HH:mm>] <prompt | @file>";
  const intervalMs = parseInterval(head);
  if (intervalMs === undefined) {
    return { ok: false, error: `bad interval "${head}": use <n>m, <n>h, or <n>d, minimum 1m` };
  }

  let remainder = rest;
  let name: string | undefined;
  let max: number | undefined;
  let until: number | undefined;
  while (remainder.trimStart().startsWith("--")) {
    const [flag, afterFlag] = nextToken(remainder);
    const [value, afterValue] = nextToken(afterFlag);
    if (value === "") return { ok: false, error: `${flag} needs a value. ${usage}` };
    remainder = afterValue;
    if (flag === "--name") {
      if (!NAME_PATTERN.test(value)) return { ok: false, error: `bad name "${value}": letters, digits, . _ - only` };
      name = value;
    } else if (flag === "--max") {
      if (!/^[1-9]\d*$/.test(value)) return { ok: false, error: `bad --max "${value}": positive integer` };
      max = Number(value);
    } else if (flag === "--until") {
      const parsed = parseUntil(value, now);
      if (!parsed.ok) return parsed;
      until = parsed.value;
    } else {
      return { ok: false, error: `unknown flag ${flag}. ${usage}` };
    }
  }

  const promptText = remainder.trim();
  if (promptText === "") return { ok: false, error: `missing prompt. ${usage}` };
  const prompt: PromptSource = promptText.startsWith("@")
    ? { kind: "file", path: promptText.slice(1) }
    : { kind: "text", text: promptText };
  return { ok: true, value: { kind: "create", interval: head, prompt, name, max, until } };
}

/** Split off the first whitespace-delimited token; returns [token, rest]. */
function nextToken(input: string): [string, string] {
  const s = input.trimStart();
  const end = s.search(/\s/);
  if (end === -1) return [s, ""];
  return [s.slice(0, end), s.slice(end)];
}

/** "5m" | "2h" | "1d" to milliseconds; undefined when unparsable or below 1m. */
export function parseInterval(text: string): number | undefined {
  const m = /^(\d+)([mhd])$/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
  const ms = n * unit;
  return ms >= MIN_INTERVAL_MS ? ms : undefined;
}

/** --until value: ISO datetime, or HH:mm meaning the next such local time. */
function parseUntil(value: string, now: number): Result<number> {
  const hm = /^(\d{1,2}):(\d{2})$/.exec(value);
  let at: number;
  if (hm) {
    const h = Number(hm[1]);
    const mm = Number(hm[2]);
    if (h > 23 || mm > 59) return { ok: false, error: `bad --until "${value}": HH:mm out of range` };
    const d = new Date(now);
    d.setHours(h, mm, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    at = d.getTime();
  } else {
    at = Date.parse(value);
    if (Number.isNaN(at)) return { ok: false, error: `bad --until "${value}": use an ISO datetime or HH:mm` };
  }
  if (at <= now) return { ok: false, error: `--until ${value} is already in the past` };
  return { ok: true, value: at };
}

/** loop-<k> with the lowest free k. */
function defaultName(loops: Loop[]): string {
  const taken = new Set(loops.map((l) => l.name));
  let k = 1;
  while (taken.has(`loop-${k}`)) k++;
  return `loop-${k}`;
}

// Prompt source

function readPrompt(cwd: string, source: PromptSource): Result<string> {
  if (source.kind === "text") return { ok: true, value: source.text };
  const file = path.resolve(cwd, source.path);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: `prompt file ${source.path}: ${message(e)}` };
  }
  const trimmed = text.trimEnd();
  if (trimmed.trim() === "") return { ok: false, error: `prompt file ${source.path} is empty` };
  return { ok: true, value: trimmed };
}

// State files

function loopsFile(cwd: string): string {
  return path.join(cwd, STATE_DIR, "loops.json");
}

function loadLoops(cwd: string): Result<Loop[]> {
  const file = loopsFile(cwd);
  if (!fs.existsSync(file)) return { ok: true, value: [] };
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `${file}: ${message(e)}` };
  }
  if (!Array.isArray(data) || !data.every(isLoop)) {
    return { ok: false, error: `${file}: unexpected shape, fix or delete it` };
  }
  return { ok: true, value: data };
}

function isLoop(value: unknown): value is Loop {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const prompt = v.prompt as Record<string, unknown> | undefined;
  return (
    typeof v.name === "string" &&
    NAME_PATTERN.test(v.name) &&
    typeof v.interval === "string" &&
    parseInterval(v.interval) !== undefined &&
    typeof prompt === "object" &&
    prompt !== null &&
    ((prompt.kind === "text" && typeof prompt.text === "string") ||
      (prompt.kind === "file" && typeof prompt.path === "string")) &&
    typeof v.dueAt === "number" &&
    typeof v.fires === "number" &&
    typeof v.paused === "boolean" &&
    (v.max === undefined || typeof v.max === "number") &&
    (v.until === undefined || typeof v.until === "number") &&
    (v.lastError === undefined || typeof v.lastError === "string")
  );
}

function saveLoops(cwd: string, loops: Loop[]): void {
  writeAtomic(loopsFile(cwd), JSON.stringify(loops, null, 2) + "\n");
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Owner: the one session in a cwd allowed to fire.

interface Owner {
  pid: number;
  sessionId: string;
  claimedAt: number;
}

function ownerFile(cwd: string): string {
  return path.join(cwd, STATE_DIR, "owner.json");
}

/** The recorded owner; a missing or unreadable file is treated as unclaimed, since it is a lock, not user data. */
function readOwner(cwd: string): Owner | undefined {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(ownerFile(cwd), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const v = data as Record<string, unknown>;
  if (typeof v.pid !== "number" || typeof v.sessionId !== "string" || typeof v.claimedAt !== "number") return undefined;
  return { pid: v.pid, sessionId: v.sessionId, claimedAt: v.claimedAt };
}

/** The pid of a live owner that is not this session, or undefined when this session may claim. */
function otherOwner(ctx: LoopContext, deps: Deps): number | undefined {
  const owner = readOwner(ctx.cwd);
  if (!owner || owner.pid === deps.pid) return undefined;
  return deps.isPidAlive(owner.pid) ? owner.pid : undefined;
}

/** Claim or keep ownership. Returns false when a live other session owns the cwd. */
function claimOwner(ctx: LoopContext, deps: Deps): boolean {
  if (otherOwner(ctx, deps) !== undefined) return false;
  const owner = readOwner(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  if (owner && owner.pid === deps.pid && owner.sessionId === sessionId) return true;
  const claim: Owner = { pid: deps.pid, sessionId, claimedAt: deps.now() };
  writeAtomic(ownerFile(ctx.cwd), JSON.stringify(claim, null, 2) + "\n");
  return true;
}

/** Remove owner.json if this session holds it. */
function releaseOwner(ctx: LoopContext, deps: Deps): void {
  const owner = readOwner(ctx.cwd);
  if (!owner || owner.pid !== deps.pid || owner.sessionId !== ctx.sessionManager.getSessionId()) return;
  fs.rmSync(ownerFile(ctx.cwd), { force: true });
}

// Helpers

/** One /loop list line: name, status, next due, interval, count, bounds, last error. */
function formatLoop(loop: Loop, owner: number | undefined): string {
  const status = loop.paused ? "paused" : owner === undefined ? "active" : `owned by pid ${owner}`;
  const parts = [
    loop.name,
    status,
    `next ${loop.paused ? "-" : formatLocal(loop.dueAt)}`,
    `every ${loop.interval}`,
    `fires ${loop.fires}`,
  ];
  if (loop.max !== undefined) parts.push(`max ${loop.max}`);
  if (loop.until !== undefined) parts.push(`until ${formatLocal(loop.until)}`);
  if (loop.lastError !== undefined) parts.push(`error: ${loop.lastError}`);
  return parts.join("  ");
}

function formatLocal(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
