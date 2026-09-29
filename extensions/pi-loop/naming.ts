// Naming a loop created without --name: from its @file, from a short prompt
// as typed, or from the session's model in one side completion that never
// touches the conversation.

import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { Loop, LoopContext, PromptSource } from "./types.ts";

/** How long the model may take to name a loop before it is abandoned. */
export const NAMING_TIMEOUT_MS = 20_000;
/** Names fit the roster's 16-column name field. */
const MAX_NAME = 16;
const CHOSEN_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const RULE = "Name this recurring task in 1 to 3 lowercase words joined by hyphens, at most 16 characters. Reply with the name only.";

/** Why the model gave no name; the create notice says so. */
export type NamingFailure = "timed out" | "failed" | "gave no usable name";

/**
 * A chosen name, or why there is none: no model, a file name that cleans to
 * nothing (the model was not tried), or a failed model call.
 */
export type Chosen = { ok: true; name: string } | { ok: false; reason: "no model" | "no file name" | NamingFailure };

/** Choose a name for a new loop's prompt; a model call is made only for a text prompt no rule names. */
export async function chooseName(
  prompt: PromptSource,
  ctx: Pick<LoopContext, "model" | "modelRegistry">,
  deadline: () => AbortSignal,
  now: number,
): Promise<Chosen> {
  const model = ctx.model;
  if (!model) return { ok: false, reason: "no model" };
  if (prompt.kind === "file") {
    const name = fileName(prompt.path);
    return name === undefined ? { ok: false, reason: "no file name" } : { ok: true, name };
  }
  const short = shortName(prompt.text);
  if (short !== undefined) return { ok: true, name: short };
  return askModel(model, ctx.modelRegistry, prompt.text, deadline(), now);
}

/**
 * One naming call, raced against the deadline so a provider that ignores the
 * signal is still abandoned on time. Every outcome of the call, even one that
 * lands after the deadline, is handled here.
 */
function askModel(
  model: Model<Api>,
  registry: LoopContext["modelRegistry"],
  text: string,
  signal: AbortSignal,
  now: number,
): Promise<Chosen> {
  const timedOut = new Promise<Chosen>((resolve) => {
    const expire = () => resolve({ ok: false, reason: "timed out" });
    if (signal.aborted) expire();
    else signal.addEventListener("abort", expire, { once: true });
  });
  const answered = Promise.resolve()
    .then(() =>
      registry.complete(
        model,
        { messages: [{ role: "user", content: [{ type: "text", text: `${RULE}\n\nTask: ${text}` }], timestamp: now }] },
        { signal, timeoutMs: NAMING_TIMEOUT_MS, maxRetries: 0, maxTokens: 4096 },
      ),
    )
    .then(fromAnswer, (): Chosen => ({ ok: false, reason: "failed" }));
  return Promise.race([timedOut, answered]);
}

function fromAnswer(answer: AssistantMessage): Chosen {
  if (answer.stopReason === "error" || answer.stopReason === "aborted") return { ok: false, reason: "failed" };
  const text = answer.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  const name = cleanName(text);
  return name === undefined ? { ok: false, reason: "gave no usable name" } : { ok: true, name };
}

/** The create notice's ending: why the model gave no name, or nothing when it named the loop or was never tried. */
export function namingNote(chosen: Chosen): string {
  if (chosen.ok || chosen.reason === "no model" || chosen.reason === "no file name") return "";
  return ` · naming ${chosen.reason}`;
}

/**
 * Clean text into a name: its first non-empty line, lowercased, spaces and
 * underscores to hyphens, characters outside [a-z0-9._-] dropped, . _ -
 * trimmed from both ends, cut to 16, trimmed again. Undefined when nothing
 * valid is left.
 */
export function cleanName(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  const cleaned = trimEnds(
    trimEnds(
      line
        .trim()
        .toLowerCase()
        .replace(/[\s_]/g, "-")
        .replace(/[^a-z0-9._-]/g, ""),
    ).slice(0, MAX_NAME),
  );
  return CHOSEN_NAME.test(cleaned) ? cleaned : undefined;
}

/** A file prompt's name: the file's base name without its extension, cleaned. */
export function fileName(file: string): string | undefined {
  return cleanName(path.basename(file, path.extname(file)));
}

/** A prompt of at most 3 words that, lowercased and hyphen-joined, is a valid name of at most 16 characters. */
export function shortName(text: string): string | undefined {
  const words = text.trim().split(/\s+/);
  if (words.length > 3) return undefined;
  const name = words.join("-").toLowerCase();
  return name.length <= MAX_NAME && CHOSEN_NAME.test(name) ? name : undefined;
}

/** The chosen name, or with the lowest free -2, -3, … when taken, the base cut so the whole stays within 16. */
export function uniqueName(base: string, loops: Loop[]): string {
  const taken = new Set(loops.map((l) => l.name));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const suffix = `-${k}`;
    const name = `${trimEnds(base.slice(0, MAX_NAME - suffix.length))}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

function trimEnds(name: string): string {
  return name.replace(/^[._-]+|[._-]+$/g, "");
}
