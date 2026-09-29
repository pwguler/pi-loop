// AC-14, checked by tsc only (bun runs *.test.ts, not this file). Fake hosts
// shaped like pi's ExtensionAPI, one `on` overload per event, each lacking one
// event pi-loop subscribes to: LoopHost must reject each, so a pi release that
// drops or renames one of those events fails `bun run typecheck`. The last host
// offers all three and must be accepted, so the rejections are about the
// missing event, not the fake's shape.

import type {
  AgentSettledEvent,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { LoopHost } from "../extensions/pi-loop/types.ts";

type Rest = Omit<LoopHost, "on">;
type On<E> = (event: E, ctx: ExtensionContext) => void;

interface NoSessionStart extends Rest {
  on(event: "session_shutdown", handler: On<SessionShutdownEvent>): void;
  on(event: "agent_settled", handler: On<AgentSettledEvent>): void;
}

interface NoSessionShutdown extends Rest {
  on(event: "session_start", handler: On<SessionStartEvent>): void;
  on(event: "agent_settled", handler: On<AgentSettledEvent>): void;
}

interface NoAgentSettled extends Rest {
  on(event: "session_start", handler: On<SessionStartEvent>): void;
  on(event: "session_shutdown", handler: On<SessionShutdownEvent>): void;
}

interface AllEvents extends Rest {
  on(event: "session_start", handler: On<SessionStartEvent>): void;
  on(event: "session_shutdown", handler: On<SessionShutdownEvent>): void;
  on(event: "agent_settled", handler: On<AgentSettledEvent>): void;
}

declare const noSessionStart: NoSessionStart;
declare const noSessionShutdown: NoSessionShutdown;
declare const noAgentSettled: NoAgentSettled;
declare const allEvents: AllEvents;

// @ts-expect-error a host without session_start is not a LoopHost
export const rejectsNoSessionStart: LoopHost = noSessionStart;
// @ts-expect-error a host without session_shutdown is not a LoopHost
export const rejectsNoSessionShutdown: LoopHost = noSessionShutdown;
// @ts-expect-error a host without agent_settled is not a LoopHost
export const rejectsNoAgentSettled: LoopHost = noAgentSettled;
export const acceptsAllEvents: LoopHost = allEvents;
