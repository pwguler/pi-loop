// One named test per acceptance criterion in docs/specs/pi-loop.md.
// AC-10 is a grep, AC-11 is a live cache measurement, AC-13 is pi install;
// those are not covered here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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
