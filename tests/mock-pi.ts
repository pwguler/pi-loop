// Mock pi host for driving extensions/pi-loop.ts in bun test.
//
// A MockPi implements the narrow LoopHost surface the extension uses: on,
// registerCommand, sendUserMessage. Fires and notices are recorded. The clock,
// pid, pid liveness, and ticker are all injected so a test drives time and
// process death explicitly. sessionManager is a Proxy that throws on every
// member except getSessionId, so any read of conversation history fails loudly.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { run, type Deps, type LoopContext, type LoopHandler, type LoopHost, type MarkdownTransform, type Panel } from "../extensions/pi-loop/index.ts";

export interface Fire {
  text: string;
  options: unknown;
}

export interface Notice {
  message: string;
  type: string | undefined;
}

export interface Status {
  key: string;
  text: string | undefined;
}

export interface OwnerFile {
  pid: number;
  sessionId: string;
  claimedAt: number;
}

export interface LoopFile {
  name: string;
  intervalMs: number;
  prompt: { kind: "text"; text: string } | { kind: "file"; path: string };
  dueAt: number;
  fires: number;
  paused: boolean;
  max?: number;
  until?: number;
  lastError?: string;
}

export class Clock {
  constructor(public now: number) {}
  advance(ms: number): void {
    this.now += ms;
  }
}

/** One workspace (cwd) shared by any number of sessions. */
export class Workspace {
  readonly cwd: string;
  readonly clock: Clock;
  readonly alive = new Set<number>();
  /** Registered tickers by pid; a kill() drops them, a shutdown stops them. */
  readonly tickers = new Map<number, Set<() => void>>();
  private nextPid = 1000;

  constructor(now: number) {
    this.cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
    this.clock = new Clock(now);
  }

  dispose(): void {
    fs.rmSync(this.cwd, { recursive: true, force: true });
  }

  file(rel: string): string {
    return path.join(this.cwd, rel);
  }

  loops(): LoopFile[] {
    const p = this.file(".pi-loop/loops.json");
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, "utf8")) as LoopFile[];
  }

  owner(): OwnerFile | undefined {
    const p = this.file(".pi-loop/owner.json");
    if (!fs.existsSync(p)) return undefined;
    return JSON.parse(fs.readFileSync(p, "utf8")) as OwnerFile;
  }

  /** Run every registered ticker once, in registration order. */
  tick(): void {
    for (const set of this.tickers.values()) for (const fn of set) fn();
  }

  deps(pid: number): Deps {
    const ws = this;
    return {
      now: () => ws.clock.now,
      pid,
      isPidAlive: (p) => ws.alive.has(p),
      ticker: (fn) => {
        const set = ws.tickers.get(pid) ?? new Set();
        set.add(fn);
        ws.tickers.set(pid, set);
        return () => {
          set.delete(fn);
        };
      },
    };
  }

  /** Start a session: fresh MockPi, fresh pid (alive), session_start emitted. */
  startSession(opts: { pid?: number; hasUI?: boolean } = {}): Session {
    const pid = opts.pid ?? this.nextPid++;
    this.alive.add(pid);
    const session = new Session(this, pid, `session-${pid}`, opts.hasUI ?? true);
    session.emit("session_start");
    return session;
  }
}

export class Session implements LoopHost {
  readonly handlers = new Map<string, LoopHandler>();
  readonly commands = new Map<string, (args: string, ctx: LoopContext) => Promise<void>>();
  readonly transformers: MarkdownTransform[] = [];
  readonly fires: Fire[] = [];
  readonly notices: Notice[] = [];
  /** Every setStatus call, in order; text undefined is a clear. */
  readonly statuses: Status[] = [];
  /** Every ctx.ui.select call: title and rows. */
  readonly selects: Array<{ title: string; options: string[] }> = [];
  /** Every ctx.ui.confirm call. */
  readonly confirms: Array<{ title: string; message: string }> = [];
  /** Scripted answers: what the user picks in a select (undefined = Esc), and what they answer to confirm. */
  selectImpl: (title: string, options: string[]) => string | undefined = () => undefined;
  confirmImpl: (title: string, message: string) => boolean = () => false;
  /** Drives a ctx.ui.custom panel: read its lines, press keys. Default presses Esc. */
  customImpl: (panel: Panel) => void = (panel) => panel.handleInput?.("\x1b");
  readonly ctx: LoopContext;
  idle = true;
  hasUI: boolean;

  constructor(
    readonly ws: Workspace,
    readonly pid: number,
    readonly sessionId: string,
    hasUI: boolean,
  ) {
    const self = this;
    this.hasUI = hasUI;
    // Tags instead of ANSI, so a test can see where each color lands.
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<b>${text}</b>`,
    };
    this.ctx = {
      cwd: ws.cwd,
      get hasUI() {
        return self.hasUI;
      },
      sessionManager: historyFree(sessionId),
      isIdle: () => self.idle,
      ui: {
        notify(message: string, type?: "info" | "warning" | "error") {
          self.notices.push({ message, type });
        },
        setStatus(key: string, text: string | undefined) {
          self.statuses.push({ key, text });
        },
        async select(title: string, options: string[]) {
          self.selects.push({ title, options });
          return self.selectImpl(title, options);
        },
        async confirm(title: string, message: string) {
          self.confirms.push({ title, message });
          return self.confirmImpl(title, message);
        },
        theme,
        custom<T>(factory: (tui: { requestRender(): void }, theme: LoopContext["ui"]["theme"], keybindings: { matches(data: string, id: "tui.select.cancel"): boolean }, done: (result: T) => void) => Panel): Promise<T> {
          return new Promise<T>((resolve) => {
            const panel = factory(
              { requestRender() {} },
              theme,
              { matches: (data, id) => id === "tui.select.cancel" && (data === "\x1b" || data === "\x03") },
              resolve,
            );
            self.customImpl(panel);
          });
        },
      },
    };
    run(this, ws.deps(pid));
  }

  on(event: "session_start" | "session_shutdown" | "agent_settled", handler: LoopHandler): void {
    this.handlers.set(event, handler);
  }

  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: LoopContext) => Promise<void> }): void {
    this.commands.set(name, options.handler);
  }

  registerMarkdownTransformer(transformer: MarkdownTransform): void {
    this.transformers.push(transformer);
  }

  /** Run the registered display transformers over a message, as pi's renderer does. */
  display(markdown: string, messageType: "user" | "assistant" | "assistant-thinking" = "user"): string {
    return this.transformers.reduce((md, t) => t(md, { messageType, isStreaming: false, availableWidth: 80 }), markdown);
  }

  sendUserMessage(text: string, options?: unknown): void {
    if (!this.idle) throw new Error("sendUserMessage while streaming without deliverAs");
    this.fires.push({ text, options });
  }

  /** Emit an event to the registered handler; a missing handler is a no-op. */
  emit(event: string): void {
    const h = this.handlers.get(event);
    if (h) h({ type: event }, this.ctx);
  }

  async command(args: string): Promise<void> {
    const h = this.commands.get("loop");
    if (!h) throw new Error("/loop is not registered");
    await h(args, this.ctx);
  }

  /** The agent finished a run: idle again, agent_settled fires. */
  settle(): void {
    this.idle = true;
    this.emit("agent_settled");
  }

  /** Graceful exit: session_shutdown fires, the pid dies. */
  shutdown(): void {
    this.emit("session_shutdown");
    this.ws.alive.delete(this.pid);
  }

  /** Crash: no shutdown event, the pid dies, its tickers stop. */
  kill(): void {
    this.ws.alive.delete(this.pid);
    this.ws.tickers.delete(this.pid);
  }

  lastNotice(): string {
    const n = this.notices[this.notices.length - 1];
    if (!n) throw new Error("no notices");
    return n.message;
  }

  clearNotices(): void {
    this.notices.length = 0;
  }

  /** The footer text as of the last setStatus call, color tags stripped; undefined when cleared or never set. */
  status(): string | undefined {
    return this.styled()?.replace(/<\/?[a-zA-Z]+>/g, "");
  }

  /** The footer text as of the last setStatus call with the mock theme's color tags. */
  styled(): string | undefined {
    return this.statuses[this.statuses.length - 1]?.text;
  }
}

/** A session manager that answers getSessionId and throws on everything else. */
function historyFree(sessionId: string): LoopContext["sessionManager"] {
  const target = { getSessionId: () => sessionId };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "getSessionId") return t.getSessionId;
      throw new Error(`sessionManager.${String(prop)} read by pi-loop: loop state must never come from conversation history`);
    },
  });
}
