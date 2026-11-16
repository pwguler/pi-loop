// One named test per acceptance criterion in docs/specs/pi-loop-tool.md: the
// loop tool the model calls to operate loops from plain-language requests.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LoopToolParams } from "../extensions/index.ts";
import { Workspace } from "./mock-pi.ts";

// 2026-09-06 10:00 local, as in pi-loop.test.ts.
const T0 = new Date(2026, 8, 6, 10, 0, 0, 0).getTime();
const MIN = 60_000;
const NOT_FOUND = "no interval or cron expression found: say 5m, every 2 hours, hourly, or daily, or start with five cron fields like 0 9 * * 1-5";

let ws: Workspace;

beforeEach(() => {
  ws = new Workspace(T0);
});

afterEach(() => {
  ws.dispose();
});

describe("AC-T1 one loop tool, registered with a snippet and guidelines that name it", () => {
  test("the tool is named loop, offers the five actions, and its guidelines say loop", () => {
    const s = ws.startSession();
    const tool = s.tools.get("loop");
    expect([...s.tools.keys()]).toEqual(["loop"]);
    expect(tool?.parameters).toMatchObject({ properties: { action: { enum: ["create", "list", "pause", "resume", "stop"] } } });
    expect(tool?.promptSnippet).toBeTruthy();
    expect(tool?.promptGuidelines.length).toBeGreaterThan(0);
    for (const g of tool?.promptGuidelines ?? []) expect(g).toContain("loop");
  });
});

describe("AC-T2 create stores the prompt as given and matches what /loop creates", () => {
  test("an interval phrase and a prompt with a duration in it: the prompt is kept whole and nothing fires", async () => {
    const s = ws.startSession();
    expect(await s.tool({ action: "create", schedule: "every 30 minutes", prompt: "retry in 10m and report", name: "build" })).toEqual({
      text: "created build, every 30m, next 2026-09-06 10:30",
    });
    expect(ws.loops()).toEqual([
      { name: "build", intervalMs: 30 * MIN, prompt: { kind: "text", text: "retry in 10m and report" }, dueAt: T0 + 30 * MIN, fires: 0, paused: false },
    ]);
    ws.tick();
    expect(s.fires).toHaveLength(0);
    ws.clock.advance(30 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text)).toEqual(["[loop build #1 2026-09-06 10:30]\nretry in 10m and report"]);
  });

  test("the same schedule, prompt, and bounds give the same record as /loop, for an interval, a cron expression, and a file prompt", async () => {
    const cases: Array<[LoopToolParams, string]> = [
      [{ action: "create", schedule: "5m", prompt: "ping", name: "a", max: 3, until: "12:00" }, "5m ping --name a --max 3 --until 12:00"],
      [{ action: "create", schedule: "0 9 * * 1-5", prompt: "summarize CI", name: "b" }, "0 9 * * 1-5 summarize CI --name b"],
      [{ action: "create", schedule: "hourly", prompt: "@prompt.md", name: "c" }, "hourly @prompt.md --name c"],
    ];
    for (const [params, typed] of cases) {
      const viaTool = new Workspace(T0);
      const viaCommand = new Workspace(T0);
      try {
        expect(await viaTool.startSession().tool(params)).toHaveProperty("text");
        await viaCommand.startSession().command(typed);
        expect(viaTool.loops()).toEqual(viaCommand.loops());
        expect(viaTool.loops()).toHaveLength(1);
      } finally {
        viaTool.dispose();
        viaCommand.dispose();
      }
    }
  });
});

describe("AC-T3 naming and errors match /loop and write nothing", () => {
  test("without a name the loop is named as /loop names it", async () => {
    const s = ws.startSession();
    expect(await s.tool({ action: "create", schedule: "5m", prompt: "ping" })).toEqual({ text: "created loop-1, every 5m, next 2026-09-06 10:05" });
  });

  test("each bad input fails with /loop's error and creates nothing", async () => {
    const s = ws.startSession();
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "taken" });
    const cases: Array<[LoopToolParams, string | RegExp]> = [
      [{ action: "create", schedule: "5m", prompt: "x", name: "bad name" }, 'bad name "bad name": letters, digits, . _ - only'],
      [{ action: "create", schedule: "5m", prompt: "x", name: "taken" }, "loop taken already exists; pick another --name or /loop stop taken"],
      [{ action: "create", schedule: "check the build", prompt: "x" }, NOT_FOUND],
      [{ action: "create", prompt: "x" }, NOT_FOUND],
      [{ action: "create", schedule: "every 5 minutes check the build", prompt: "x" }, /^schedule "every 5 minutes check the build" holds more than/],
      [{ action: "create", schedule: "0m", prompt: "x" }, 'interval "0m" is below the minimum 1m'],
      [{ action: "create", schedule: "5m", prompt: "x", max: 0 }, 'bad --max "0": positive integer'],
      [{ action: "create", schedule: "5m", prompt: "x", until: "2020-01-01T00:00" }, "--until 2020-01-01T00:00 is already in the past; give a later time"],
      [{ action: "create", schedule: "5m", prompt: "  " }, /^missing prompt/],
      [{ action: "create", schedule: "5m" }, /^missing prompt/],
    ];
    for (const [params, error] of cases) {
      const out = await s.tool(params);
      expect(out).toHaveProperty("error");
      if ("error" in out) expect([params, out.error]).toEqual([params, typeof error === "string" ? error : expect.stringMatching(error)]);
    }
    expect(ws.loops().map((l) => l.name)).toEqual(["taken"]);
  });
});

describe("AC-T4 pause, resume, and stop act as the typed commands do", () => {
  test("pause, resume, stop by name, with the typed command's errors", async () => {
    const s = ws.startSession();
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "p" });
    expect(await s.tool({ action: "pause", name: "p" })).toEqual({ text: "paused p" });
    expect(ws.loops()[0]?.paused).toBe(true);
    expect(await s.tool({ action: "pause", name: "p" })).toEqual({ error: "p is already paused; /loop resume p resumes it" });
    ws.clock.advance(7 * MIN);
    expect(await s.tool({ action: "resume", name: "p" })).toEqual({ text: "resumed p, next 2026-09-06 10:10" });
    expect(await s.tool({ action: "resume", name: "p" })).toEqual({ error: "p is not paused; /loop pause p pauses it" });
    expect(await s.tool({ action: "stop", name: "nope" })).toEqual({ error: "no loop named nope; /loop list shows the names" });
    expect(await s.tool({ action: "stop" })).toEqual({ error: "stop needs the loop's name" });
    expect(await s.tool({ action: "stop", name: "p" })).toEqual({ text: "stopped p" });
    expect(ws.loops()).toEqual([]);
  });

  test("a fire's run stops its own loop: no further fire", async () => {
    const s = ws.startSession();
    await s.tool({ action: "create", schedule: "5m", prompt: "check, stop when green", name: "watch" });
    ws.clock.advance(5 * MIN);
    ws.tick();
    s.busy();
    expect(await s.tool({ action: "stop", name: "watch" })).toEqual({ text: "stopped watch" });
    s.settle();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
  });
});

describe("AC-T5 list returns the text listing and opens no roster", () => {
  test("one line per loop in the TUI too, and no loops when empty", async () => {
    const s = ws.startSession();
    expect(await s.tool({ action: "list" })).toEqual({ text: "no loops" });
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "a" });
    await s.tool({ action: "create", schedule: "2h", prompt: "pong", name: "b", max: 4 });
    const before = s.status();
    expect(await s.tool({ action: "list" })).toEqual({
      text: ["a  active  next 2026-09-06 10:05  every 5m  fires 0", "b  active  next 2026-09-06 12:00  every 2h  fires 0  max 4"].join("\n"),
    });
    expect(s.status()).toBe(before);
    expect(s.press("j")).toBe(false);
  });
});

describe("AC-T6 the result is the notice text; a tool call raises no notice", () => {
  test("success and failure both leave ctx.ui.notify untouched", async () => {
    const s = ws.startSession();
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "a" });
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "a" });
    await s.tool({ action: "pause", name: "a" });
    await s.tool({ action: "list" });
    await s.tool({ action: "stop", name: "a" });
    expect(s.notices).toEqual([]);
  });
});

describe("AC-T7 the status line shows a tool call's change at once", () => {
  test("create, pause, and stop redraw the line before any tick", async () => {
    const s = ws.startSession();
    expect(s.status()).toBeUndefined();
    await s.tool({ action: "create", schedule: "5m", prompt: "ping", name: "a" });
    expect(s.status()).toBe("  1 active loop · next a 10:05");
    await s.tool({ action: "pause", name: "a" });
    expect(s.status()).toBe("  1 paused loop");
    await s.tool({ action: "stop", name: "a" });
    expect(s.status()).toBeUndefined();
  });
});

describe("AC-T8 outside the TUI the tool writes the state file and never fires", () => {
  test("an rpc tool create claims nothing and fires nothing; the TUI owner fires it", async () => {
    const r = ws.startSession({ mode: "rpc", hasUI: true });
    expect(await r.tool({ action: "create", schedule: "5m", prompt: "x", name: "a" })).toEqual({ text: "created a, every 5m, next 2026-09-06 10:05" });
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(r.fires).toHaveLength(0);
    expect(ws.owner()).toBeUndefined();
    const t = ws.startSession();
    ws.tick();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(t.fires.map((f) => f.text)).toEqual(["[loop a #1 2026-09-06 10:10]\nx"]);
  });
});
