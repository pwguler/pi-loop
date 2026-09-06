// State on disk: <cwd>/.pi-loop/loops.json and owner.json, and the prompt
// file a loop may point at. Loop state lives here and nowhere else.

import * as fs from "node:fs";
import * as path from "node:path";
import { intervals, MIN_INTERVAL_MS } from "./interval.ts";
import { NAME_PATTERN, type Deps, type Loop, type LoopContext, type PromptSource, type Result } from "./types.ts";

const STATE_DIR = ".pi-loop";

export function readPrompt(cwd: string, source: PromptSource): Result<string> {
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

function loopsFile(cwd: string): string {
  return path.join(cwd, STATE_DIR, "loops.json");
}

export function loadLoops(cwd: string): Result<Loop[]> {
  const file = loopsFile(cwd);
  if (!fs.existsSync(file)) return { ok: true, value: [] };
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { ok: false, error: `${file}: ${message(e)}` };
  }
  if (!Array.isArray(data)) return { ok: false, error: `${file}: unexpected shape, fix or delete it` };
  const loops: Loop[] = [];
  for (const entry of data) {
    const loop = normalizeLoop(entry);
    if (!loop) return { ok: false, error: `${file}: unexpected shape, fix or delete it` };
    loops.push(loop);
  }
  return { ok: true, value: loops };
}

/**
 * Validate one stored loop. The first schema stored the interval as a phrase
 * (`interval: "2m"`); it is read here and written back as intervalMs on the
 * next save.
 */
function normalizeLoop(value: unknown): Loop | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const intervalMs =
    typeof v.intervalMs === "number"
      ? v.intervalMs
      : typeof v.interval === "string"
        ? intervals(v.interval).find((c) => c.text === v.interval)?.ms
        : undefined;
  if (intervalMs === undefined || !Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS) return undefined;
  const { interval: _phrase, ...rest } = v;
  const candidate: unknown = { ...rest, intervalMs };
  return isLoop(candidate) ? candidate : undefined;
}

function isLoop(value: unknown): value is Loop {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const prompt = v.prompt as Record<string, unknown> | undefined;
  return (
    typeof v.name === "string" &&
    NAME_PATTERN.test(v.name) &&
    typeof v.intervalMs === "number" &&
    Number.isInteger(v.intervalMs) &&
    v.intervalMs >= MIN_INTERVAL_MS &&
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

export function saveLoops(cwd: string, loops: Loop[]): void {
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
export function otherOwner(ctx: LoopContext, deps: Deps): number | undefined {
  const owner = readOwner(ctx.cwd);
  if (!owner || owner.pid === deps.pid) return undefined;
  return deps.isPidAlive(owner.pid) ? owner.pid : undefined;
}

/** Claim or keep ownership. Returns false when a live other session owns the cwd. */
export function claimOwner(ctx: LoopContext, deps: Deps): boolean {
  if (otherOwner(ctx, deps) !== undefined) return false;
  const owner = readOwner(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();
  if (owner && owner.pid === deps.pid && owner.sessionId === sessionId) return true;
  const claim: Owner = { pid: deps.pid, sessionId, claimedAt: deps.now() };
  writeAtomic(ownerFile(ctx.cwd), JSON.stringify(claim, null, 2) + "\n");
  return true;
}

/** Remove owner.json if this session holds it. */
export function releaseOwner(ctx: LoopContext, deps: Deps): void {
  const owner = readOwner(ctx.cwd);
  if (!owner || owner.pid !== deps.pid || owner.sessionId !== ctx.sessionManager.getSessionId()) return;
  fs.rmSync(ownerFile(ctx.cwd), { force: true });
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
