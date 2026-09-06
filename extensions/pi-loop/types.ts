// The shapes pi-loop works with: the narrow slice of pi's API it uses, and
// the loop record it stores. The default export in index.ts is typed against
// pi's ExtensionAPI, so tsc checks that pi still satisfies LoopHost.

import type { Theme } from "@earendil-works/pi-coding-agent";

export interface Panel {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface LoopContext {
  cwd: string;
  hasUI: boolean;
  sessionManager: { getSessionId(): string };
  isIdle(): boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    theme: Pick<Theme, "fg" | "bold">;
    select(title: string, options: string[]): Promise<string | undefined>;
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
  on(event: "session_start" | "session_shutdown" | "agent_settled", handler: LoopHandler): void;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: LoopContext) => Promise<void> },
  ): void;
  /** Display-only: pi renders the returned Markdown; the stored message and model context are untouched. */
  registerMarkdownTransformer(transformer: MarkdownTransform): void;
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
