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
