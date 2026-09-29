// The shapes pi-loop works with: the narrow slice of pi's API it uses, and
// the loop record it stores. The default export in index.ts is typed against
// pi's ExtensionAPI, so tsc checks that pi still satisfies LoopHost.

import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { Theme } from "@earendil-works/pi-coding-agent";

export interface Panel {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

/**
 * The tui a widget factory is given. pi-tui's TUI interface has no focus
 * getter, but its runtime object does; optional, so pi's TUI still fits and a
 * tui without one reads as not focused.
 */
export interface WidgetTui {
  requestRender(): void;
  getFocusedComponent?(): unknown;
}

export interface LoopContext {
  cwd: string;
  mode: "tui" | "rpc" | "json" | "print";
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  /** The session's current model; undefined when none is set. */
  model: Model<Api> | undefined;
  /** A side completion outside the conversation, used only to name a loop. */
  modelRegistry: {
    complete(model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>): Promise<AssistantMessage>;
  };
  isIdle(): boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    /** A component widget; undefined removes it. pi calls the factory synchronously. */
    setWidget(
      key: string,
      factory: ((tui: WidgetTui, theme: Pick<Theme, "fg" | "bold">) => Panel) | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ): void;
    /** Sees every terminal key before the editor; {consume:true} stops it there. Returns the unsubscribe. */
    onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
    getEditorText(): string;
    confirm(title: string, message: string): Promise<boolean>;
    custom<T>(
      factory: (
        tui: { requestRender(): void },
        theme: Pick<Theme, "fg" | "bold">,
        keybindings: { matches(data: string, id: "tui.select.cancel"): boolean },
        done: (result: T) => void,
      ) => Panel,
    ): Promise<T>;
  };
}

export type LoopHandler = (event: unknown, ctx: LoopContext) => void;

export type MarkdownTransform = (
  markdown: string,
  context: { messageType: "user" | "assistant" | "assistant-thinking"; isStreaming: boolean; availableWidth: number },
) => string;

export interface LoopHost {
  // One overload per event, not one over their union: a union parameter compares bivariantly, so a
  // host missing one event would still fit. Each overload needs its own match in pi's ExtensionAPI.
  on(event: "session_start", handler: LoopHandler): void;
  on(event: "session_shutdown", handler: LoopHandler): void;
  on(event: "agent_start", handler: LoopHandler): void;
  on(event: "agent_settled", handler: LoopHandler): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: LoopContext) => Promise<void> },
  ): void;
  /** Display-only: pi renders the returned Markdown; the stored message and model context are untouched. */
  registerMarkdownTransformer(transformer: MarkdownTransform): void;
  sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): void;
}

/** Time and process seams, injected so tests drive them. */
export interface Deps {
  now(): number;
  pid: number;
  isPidAlive(pid: number): boolean;
  /** Start a periodic tick; returns the stop function. */
  ticker(fn: () => void): () => void;
  /** Start the 8-second naming deadline; its signal aborts when the time is up. */
  namingDeadline(): AbortSignal;
}

export type PromptSource = { kind: "text"; text: string } | { kind: "file"; path: string };

export interface Loop {
  name: string;
  intervalMs: number;
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

/** Loop names: letters, digits, . _ - only. */
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
