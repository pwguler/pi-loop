// One named test per acceptance criterion in docs/specs/pi-loop.md.
// AC-10 is a grep, AC-11 is a live cache measurement, AC-13 is pi install;
// those are not covered here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { Workspace } from "./mock-pi.ts";

// A fixed instant in local time so header and list output are asserted
// without timezone math: 2026-09-06 10:00 local.
const T0 = new Date(2026, 8, 6, 10, 0, 0, 0).getTime();
const MIN = 60_000;

let ws: Workspace;

beforeEach(() => {
  ws = new Workspace(T0);
});

afterEach(() => {
  ws.dispose();
});

describe("AC-1 create fires immediately as one trailing user message", () => {
  test("/loop 5m <prompt> fires [loop loop-1 #1 <YYYY-MM-DD HH:mm>] then the prompt", async () => {
    const s = ws.startSession();
    await s.command("5m check the build");
    expect(s.fires).toHaveLength(1);
    expect(s.fires[0]?.text).toBe("[loop loop-1 #1 2026-09-06 10:00]\ncheck the build");
    expect(s.fires[0]?.options).toBeUndefined();
  });

  test("interval syntax 5m, 2h, 1d parses; below 1m or unparsable rejects and creates nothing", async () => {
    const s = ws.startSession();
    await s.command("2h a");
    await s.command("1d b");
    await s.command("1m c");
    expect(ws.loops().map((l) => l.interval)).toEqual(["2h", "1d", "1m"]);
    expect(s.fires).toHaveLength(3);

    for (const bad of ["30s x", "0m x", "5 x", "5x x", "m x", "1.5h x", "-5m x"]) {
      s.clearNotices();
      await s.command(bad);
      expect(s.lastNotice()).toMatch(/interval/);
      expect(s.notices[0]?.type).toBe("error");
    }
    expect(ws.loops()).toHaveLength(3);
    expect(s.fires).toHaveLength(3);
  });

  test("an interval with no prompt rejects and creates nothing", async () => {
    const s = ws.startSession();
    await s.command("5m");
    expect(s.notices[0]?.type).toBe("error");
    expect(ws.loops()).toHaveLength(0);
    expect(s.fires).toHaveLength(0);
  });
});

describe("AC-2 next fire is due at lastFiredAt + interval and only when idle", () => {
  test("fires at the due tick, not before", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.settle();
    ws.clock.advance(4 * MIN + 59_000);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    ws.clock.advance(1000);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:05]\nping");
  });

  test("a tick due while busy fires once on agent_settled, and the next due counts from that fire", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.settle();

    // The agent is busy across the due instant; several ticks pass.
    s.idle = false;
    ws.clock.advance(5 * MIN);
    ws.tick();
    ws.clock.advance(2 * MIN);
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(1);

    // Settles at 10:07: exactly one fire, due next at 10:12 not 10:10.
    s.settle();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:07]\nping");
    ws.tick();
    s.settle();
    expect(s.fires).toHaveLength(2);

    ws.clock.advance(3 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    ws.clock.advance(2 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    expect(s.fires[2]?.text).toBe("[loop loop-1 #3 2026-09-06 10:12]\nping");
  });

  test("a create while busy fires nothing until the agent settles", async () => {
    const s = ws.startSession();
    s.idle = false;
    await s.command("5m ping");
    expect(ws.loops()).toHaveLength(1);
    expect(s.fires).toHaveLength(0);
    s.settle();
    expect(s.fires).toHaveLength(1);
  });
});

describe("AC-7 list, stop, pause, resume", () => {
  test("/loop list shows name, interval, next due, count, status; bare /loop prints the same", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    await s.command("2h --name nightly --max 4 pong");
    s.clearNotices();
    await s.command("list");
    const listed = s.lastNotice();
    expect(listed).toBe(
      [
        "loop-1  active  next 2026-09-06 10:05  every 5m  fires 1",
        "nightly  active  next 2026-09-06 12:00  every 2h  fires 1  max 4",
      ].join("\n"),
    );
    s.clearNotices();
    await s.command("");
    expect(s.lastNotice()).toBe(listed);
  });

  test("/loop list with no loops says so", async () => {
    const s = ws.startSession();
    await s.command("list");
    expect(s.lastNotice()).toBe("no loops");
  });

  test("/loop stop <name> removes the loop; unknown names are an error", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    await s.command("5m --name b pong");
    await s.command("stop loop-1");
    expect(ws.loops().map((l) => l.name)).toEqual(["b"]);
    ws.clock.advance(10 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual([
      "[loop loop-1 #1 2026-09-06 10:00]",
      "[loop b #1 2026-09-06 10:00]",
      "[loop b #2 2026-09-06 10:10]",
    ]);
    s.clearNotices();
    await s.command("stop nope");
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toMatch(/nope/);
  });

  test("pause halts firing and keeps the counter; resume counts the next due from the resume moment", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    ws.clock.advance(MIN);
    await s.command("pause loop-1");
    s.clearNotices();
    await s.command("list");
    expect(s.lastNotice()).toBe("loop-1  paused  next -  every 5m  fires 1");

    ws.clock.advance(20 * MIN);
    ws.tick();
    s.settle();
    expect(s.fires).toHaveLength(1);

    // Resume at 10:21: nothing fires now; next due is 10:26.
    await s.command("resume loop-1");
    ws.tick();
    expect(s.fires).toHaveLength(1);
    s.clearNotices();
    await s.command("list");
    expect(s.lastNotice()).toBe("loop-1  active  next 2026-09-06 10:26  every 5m  fires 1");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:26]\nping");
  });

  test("pause of a paused loop and resume of an active loop are errors", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.clearNotices();
    await s.command("resume loop-1");
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toBe("loop-1 is not paused");
    await s.command("pause loop-1");
    s.clearNotices();
    await s.command("pause loop-1");
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toBe("loop-1 is already paused");
  });
});

describe("AC-3 @file prompt source is re-read at every fire", () => {
  test("editing the file between fires changes the next fire's text", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "first version\n");
    await s.command("5m @prompt.md");
    expect(s.fires[0]?.text).toBe("[loop loop-1 #1 2026-09-06 10:00]\nfirst version");
    expect(ws.loops()[0]?.prompt).toEqual({ kind: "file", path: "prompt.md" });

    fs.writeFileSync(ws.file("prompt.md"), "second version\nwith two lines\n");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:05]\nsecond version\nwith two lines");
  });

  test("a missing file at fire time skips that fire, records the error in list, keeps the loop alive", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "v1");
    await s.command("5m @prompt.md");
    fs.rmSync(ws.file("prompt.md"));

    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    s.clearNotices();
    await s.command("list");
    expect(s.lastNotice()).toMatch(/^loop-1  active  next 2026-09-06 10:10  every 5m  fires 1  error: prompt file prompt\.md: .*ENOENT/);

    // The loop is alive: the file comes back and the next fire is #2 with no error shown.
    fs.writeFileSync(ws.file("prompt.md"), "v2");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:10]\nv2");
    s.clearNotices();
    await s.command("list");
    expect(s.lastNotice()).toBe("loop-1  active  next 2026-09-06 10:15  every 5m  fires 1".replace("fires 1", "fires 2"));
  });

  test("an empty file at fire time is a skip with its own error", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "   \n");
    await s.command("5m @prompt.md");
    expect(s.fires).toHaveLength(0);
    await s.command("list");
    expect(s.lastNotice()).toMatch(/error: prompt file prompt\.md is empty$/);
  });
});

describe("AC-4 state lives in <cwd>/.pi-loop/loops.json and survives a restart", () => {
  test("a new session in the same cwd resumes every non-stopped loop with counter, prompt, interval, bounds", async () => {
    const a = ws.startSession();
    await a.command("5m --max 10 --until 23:30 ping");
    await a.command("2h --name nightly @notes.md");
    await a.command("1h --name idle pong");
    await a.command("pause idle");
    await a.command("1m --name gone bye");
    await a.command("stop gone");
    ws.clock.advance(MIN);
    ws.tick();
    a.shutdown();

    expect(fs.existsSync(ws.file(".pi-loop/loops.json"))).toBe(true);
    const b = ws.startSession();
    await b.command("list");
    expect(b.lastNotice()).toBe(
      [
        "loop-1  active  next 2026-09-06 10:05  every 5m  fires 1  max 10  until 2026-09-06 23:30",
        "nightly  active  next 2026-09-06 12:00  every 2h  fires 0  error: prompt file notes.md: ENOENT: no such file or directory, open '" + ws.file("notes.md") + "'",
        "idle  paused  next -  every 1h  fires 1",
      ].join("\n"),
    );
    expect(ws.loops().map((l) => l.prompt)).toEqual([
      { kind: "text", text: "ping" },
      { kind: "file", path: "notes.md" },
      { kind: "text", text: "pong" },
    ]);

    // The counter continues in b, not from zero.
    ws.clock.advance(4 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:05]\nping"]);
  });
});

describe("AC-5 catch-up: a loop due on resume fires once, then continues on cadence from that fire", () => {
  test("many missed fires collapse into one, at the first idle moment", async () => {
    const a = ws.startSession();
    await a.command("50m ping");
    ws.clock.advance(10 * MIN);
    a.kill();

    // Back at 12:30: three fires were missed (10:50, 11:40, 12:30).
    ws.clock.advance(140 * MIN);
    const b = ws.startSession();
    expect(b.fires).toHaveLength(0);
    b.idle = false;
    ws.tick();
    expect(b.fires).toHaveLength(0);
    b.settle();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 12:30]\nping"]);
    ws.tick();
    expect(b.fires).toHaveLength(1);

    // Next due is 13:20, counted from the catch-up fire.
    await b.command("list");
    expect(b.lastNotice()).toBe("loop-1  active  next 2026-09-06 13:20  every 50m  fires 2");
    ws.clock.advance(49 * MIN);
    ws.tick();
    expect(b.fires).toHaveLength(1);
    ws.clock.advance(MIN);
    ws.tick();
    expect(b.fires).toHaveLength(2);
  });

  test("a loop not yet due on resume waits for its due time", async () => {
    const a = ws.startSession();
    await a.command("50m ping");
    ws.clock.advance(10 * MIN);
    a.shutdown();
    ws.clock.advance(10 * MIN);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    ws.clock.advance(30 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:50]\nping"]);
  });
});
