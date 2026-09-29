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
import type { Api, AssistantMessage, Context, Model, StopReason } from "@earendil-works/pi-ai";
import { run, type Deps, type LoopContext, type LoopHandler, type LoopHost, type MarkdownTransform, type Panel } from "../extensions/pi-loop/index.ts";

export interface Fire {
  text: string;
  options: unknown;
}

export interface Notice {
  message: string;
  type: string | undefined;
}

/** One ctx.ui.setWidget call; factory undefined is a removal. */
export interface WidgetCall {
  key: string;
  factory: WidgetFactory | undefined;
  placement: "aboveEditor" | "belowEditor" | undefined;
}

type WidgetFactory = Exclude<Parameters<LoopContext["ui"]["setWidget"]>[1], undefined>;
type WidgetTheme = Parameters<WidgetFactory>[1];

type Complete = LoopContext["modelRegistry"]["complete"];
export type ModelOptions = Parameters<Complete>[2];

/** One ctx.modelRegistry.complete call, as the extension made it. */
export interface ModelCall {
  model: Model<Api>;
  context: Context;
  options: ModelOptions;
}

/**
 * How the scripted model answers: with text, with text after reasoning a
 * number of tokens first (like a reasoning model, it stops at "length" with
 * only its thinking when maxTokens runs out before the text), with an error or
 * abort stop reason, by throwing, by never settling until its signal aborts
 * (then it rejects), or by never settling at all, deaf to the signal.
 */
export type ModelAnswer =
  | { text: string }
  | { reasoningTokens: number; text: string }
  | { stopReason: Extract<StopReason, "error" | "aborted"> }
  | { throws: Error }
  | "until-aborted"
  | "never";

/** A session model for the tests that set one; ctx.model is undefined by default. */
export const TEST_MODEL: Model<Api> = {
  id: "test-model",
  name: "Test model",
  api: "openai-completions",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4096,
};

function assistant(text: string, stopReason: StopReason, content: AssistantMessage["content"] = [{ type: "text", text }]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: 0,
  };
}

/** Tags instead of ANSI, so a test can see where each color lands. */
const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

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
  /** Every naming deadline started, in order; expireNaming() passes them all. */
  readonly namingDeadlines: AbortController[] = [];
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

  /** The 20 seconds of every naming deadline started so far pass now. */
  expireNaming(): void {
    for (const c of this.namingDeadlines) c.abort();
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
      namingDeadline: () => {
        const c = new AbortController();
        ws.namingDeadlines.push(c);
        return c.signal;
      },
    };
  }

  /** Start a session: fresh MockPi, fresh pid (alive), session_start emitted. */
  startSession(opts: { pid?: number; hasUI?: boolean; mode?: LoopContext["mode"] } = {}): Session {
    const pid = opts.pid ?? this.nextPid++;
    this.alive.add(pid);
    const session = new Session(this, pid, `session-${pid}`, opts.hasUI ?? true, opts.mode ?? "tui");
    session.emit("session_start");
    return session;
  }
}

/** Wide enough that no status line in these tests is cut. */
const SCREEN_WIDTH = 200;

type InputHandler = Parameters<LoopContext["ui"]["onTerminalInput"]>[0];

/** A component shaped like pi's prompt editor: what has focus while the user types. */
export function editorComponent(): unknown {
  return { render: () => [], invalidate() {}, handleInput() {}, getText: () => "", setText() {} };
}

/** A component shaped like a dialog or selector: focusable, but not the editor. */
export function dialogComponent(): unknown {
  return { render: () => [], invalidate() {}, handleInput() {} };
}

export class Session implements LoopHost {
  readonly handlers = new Map<string, LoopHandler>();
  readonly commands = new Map<string, (args: string, ctx: LoopContext) => Promise<void>>();
  readonly transformers: MarkdownTransform[] = [];
  readonly fires: Fire[] = [];
  readonly notices: Notice[] = [];
  /** Every setWidget call, in order. */
  readonly widgets: WidgetCall[] = [];
  /** How many times the registered widget asked for a redraw. */
  requestRenders = 0;
  /** When set, the next requestRender throws it, once. */
  failNextRender: Error | undefined;
  /** The registered widget, as pi keeps it after calling the factory. */
  private widget: Panel | undefined;
  /** What the screen shows: the widget's lines as of its registration or its last requestRender. */
  private screen: string[] | undefined;
  /** Terminal input listeners, in subscription order. */
  readonly inputListeners: InputHandler[] = [];
  /** Keys that were not consumed and so reached the editor, as rewritten by the listeners. */
  readonly editorKeys: string[] = [];
  /** The prompt editor's text. */
  editorText = "";
  /** What the widget's tui reports as focused; the editor by default. */
  focused: unknown = editorComponent();
  /** Every ctx.ui.confirm call. */
  readonly confirms: Array<{ title: string; message: string }> = [];
  /** Scripted answer: what the user answers to confirm. */
  confirmImpl: (title: string, message: string) => boolean = () => false;
  /** Drives a ctx.ui.custom panel: read its lines, press keys. Default presses Esc. */
  customImpl: (panel: Panel) => void = (panel) => panel.handleInput?.("\x1b");
  /** The session's current model; none by default, so names fall back to loop-<k>. */
  model: Model<Api> | undefined;
  /** Every ctx.modelRegistry.complete call. */
  readonly modelCalls: ModelCall[] = [];
  /** Scripted answer of the model to every call. */
  modelAnswer: ModelAnswer = { text: "unscripted" };
  readonly ctx: LoopContext;
  idle = true;
  hasUI: boolean;
  mode: LoopContext["mode"];

  constructor(
    readonly ws: Workspace,
    readonly pid: number,
    readonly sessionId: string,
    hasUI: boolean,
    mode: LoopContext["mode"],
  ) {
    const self = this;
    this.hasUI = hasUI;
    this.mode = mode;
    this.ctx = {
      cwd: ws.cwd,
      get mode() {
        return self.mode;
      },
      get hasUI() {
        return self.hasUI;
      },
      get model() {
        return self.model;
      },
      modelRegistry: {
        complete(model, context, options) {
          self.modelCalls.push({ model, context, options });
          const answer = self.modelAnswer;
          if (answer === "never") return new Promise<AssistantMessage>(() => {});
          if (answer === "until-aborted") {
            return new Promise<AssistantMessage>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            });
          }
          if ("throws" in answer) throw answer.throws;
          if ("stopReason" in answer) return Promise.resolve(assistant("", answer.stopReason));
          if ("reasoningTokens" in answer) {
            const thinking = { type: "thinking" as const, thinking: "reasoning ".repeat(answer.reasoningTokens) };
            if ((options?.maxTokens ?? Infinity) < answer.reasoningTokens) return Promise.resolve(assistant("", "length", [thinking]));
            return Promise.resolve(assistant(answer.text, "stop", [thinking, { type: "text", text: answer.text }]));
          }
          return Promise.resolve(assistant(answer.text, "stop"));
        },
      },
      sessionManager: historyFree(sessionId),
      isIdle: () => self.idle,
      ui: {
        notify(message: string, type?: "info" | "warning" | "error") {
          self.notices.push({ message, type });
        },
        setWidget(key, factory, options) {
          self.widgets.push({ key, factory, placement: options?.placement });
          // Like pi: the factory runs synchronously inside setWidget.
          self.widget = factory?.({ requestRender: () => self.redraw(), getFocusedComponent: () => self.focused }, theme);
          self.screen = self.widget?.render(SCREEN_WIDTH);
        },
        onTerminalInput(handler) {
          self.inputListeners.push(handler);
          return () => {
            const i = self.inputListeners.indexOf(handler);
            if (i >= 0) self.inputListeners.splice(i, 1);
          };
        },
        getEditorText: () => self.editorText,
        async confirm(title: string, message: string) {
          self.confirms.push({ title, message });
          return self.confirmImpl(title, message);
        },
        custom<T>(factory: (tui: { requestRender(): void }, theme: WidgetTheme, keybindings: { matches(data: string, id: "tui.select.cancel"): boolean }, done: (result: T) => void) => Panel): Promise<T> {
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

  /**
   * A key from the terminal, as pi-tui delivers it: listeners run in
   * subscription order, the first {consume:true} stops it, a returned data
   * rewrites it. Returns whether it was consumed; an unconsumed key is
   * recorded as reaching the editor.
   */
  press(data: string): boolean {
    let current = data;
    for (const listener of [...this.inputListeners]) {
      const result = listener(current);
      if (result?.consume) return true;
      if (result?.data !== undefined) current = result.data;
    }
    this.editorKeys.push(current);
    return false;
  }

  /** Let pending promise chains finish, such as a panel flow started by a key: resolves on the next macrotask. */
  async flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  private redraw(): void {
    const failure = this.failNextRender;
    this.failNextRender = undefined;
    if (failure) throw failure;
    this.requestRenders += 1;
    this.screen = this.widget?.render(SCREEN_WIDTH);
  }

  /** The widget's lines on screen joined by newlines, color tags stripped; undefined when no widget is registered. */
  status(): string | undefined {
    return this.styled()?.replace(/<\/?[a-zA-Z]+>/g, "");
  }

  /** The widget's lines on screen joined by newlines, with the mock theme's color tags. */
  styled(): string | undefined {
    return this.screen?.join("\n");
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
