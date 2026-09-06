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

  test("the interval phrase may lead or trail the prompt, with or without every/each", async () => {
    const s = ws.startSession();
    const cases: Array<[string, string, number]> = [
      ["5m check the build", "check the build", 5 * MIN],
      ["every 5 minutes check the build", "check the build", 5 * MIN],
      ["each 2 hours, check the build", "check the build", 120 * MIN],
      ["hourly check the build", "check the build", 60 * MIN],
      ["daily: check the build", "check the build", 1440 * MIN],
      ["check the build every 5 minutes", "check the build", 5 * MIN],
      ["check the build, every 5 min.", "check the build", 5 * MIN],
      ["check the build 2h", "check the build", 120 * MIN],
      ["check the build and every hour", "check the build", 60 * MIN],
      ["check the build every 1 hour 30 minutes", "check the build", 90 * MIN],
      ["1h30m check the build", "check the build", 90 * MIN],
      ["every day check the build", "check the build", 1440 * MIN],
    ];
    for (const [input, prompt, ms] of cases) {
      s.fires.length = 0;
      await s.command(`--name c ${input}`);
      expect(s.fires.map((f) => f.text.split("\n").slice(1).join("\n"))).toEqual([prompt]);
      expect(ws.loops().at(-1)?.intervalMs).toBe(ms);
      await s.command("stop c");
    }
  });

  test("in the middle of the text only every/each counts, and it is cut out cleanly", async () => {
    const s = ws.startSession();
    await s.command("check the build every 5 minutes and report");
    expect(s.fires[0]?.text).toBe("[loop loop-1 #1 2026-09-06 10:00]\ncheck the build and report");
    await s.command("check the build, every 5 minutes, then report");
    expect(s.fires[1]?.text).toBe("[loop loop-2 #1 2026-09-06 10:00]\ncheck the build then report");

    // A bare duration in the middle is prompt text, not an interval.
    s.clearNotices();
    await s.command("wait 5 minutes then check the build");
    expect(s.notices).toEqual([{ message: "no interval found: say 5m, every 2 hours, hourly, or daily", type: "error" }]);
    await s.command("hourly wait 5 minutes then check the build");
    expect(s.fires[2]?.text).toBe("[loop loop-3 #1 2026-09-06 10:00]\nwait 5 minutes then check the build");
  });

  test("two interval phrases reject with both shown and create nothing", async () => {
    const s = ws.startSession();
    await s.command("5m check the build every 2 hours");
    expect(s.notices).toEqual([{ message: 'more than one interval: "5m" and "every 2 hours"; say one', type: "error" }]);
    expect(ws.loops()).toHaveLength(0);
    expect(s.fires).toHaveLength(0);
  });

  test("below 1m, no unit, unknown unit, or no interval at all rejects and creates nothing", async () => {
    const s = ws.startSession();
    for (const bad of ["30 seconds x", "30s x", "0m x", "every 0 minutes x", "5 x", "5x x", "m x", "check the build"]) {
      s.clearNotices();
      await s.command(bad);
      expect(s.lastNotice()).toMatch(/interval/);
      expect(s.notices[0]?.type).toBe("error");
    }
    expect(ws.loops()).toHaveLength(0);
    expect(s.fires).toHaveLength(0);
  });

  test("an interval with no prompt rejects and creates nothing", async () => {
    const s = ws.startSession();
    for (const bad of ["5m", "every 5 minutes", "hourly."]) {
      s.clearNotices();
      await s.command(bad);
      expect(s.lastNotice()).toMatch(/missing prompt/);
    }
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

describe("AC-6 one owner session per cwd", () => {
  test("owner.json holds {pid, sessionId, claimedAt}; only the owner fires; the other shows owned by pid", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    expect(ws.owner()).toEqual({ pid: a.pid, sessionId: a.sessionId, claimedAt: T0 });

    const b = ws.startSession();
    b.clearNotices();
    await b.command("list");
    expect(b.lastNotice()).toBe(`loop-1  owned by pid ${a.pid}  next 2026-09-06 10:05  every 5m  fires 1`);

    ws.clock.advance(5 * MIN);
    ws.tick();
    b.settle();
    expect(a.fires).toHaveLength(2);
    expect(b.fires).toHaveLength(0);
    expect(ws.owner()?.pid).toBe(a.pid);

    // A loop created from the non-owner is fired by the owner, not the creator.
    b.clearNotices();
    await b.command("5m --name second pong");
    expect(b.lastNotice()).toBe(`created second, every 5m, owned by pid ${a.pid}`);
    expect(b.fires).toHaveLength(0);
    ws.tick();
    expect(a.fires.map((f) => f.text.split("\n")[0])).toEqual([
      "[loop loop-1 #1 2026-09-06 10:00]",
      "[loop loop-1 #2 2026-09-06 10:05]",
      "[loop second #1 2026-09-06 10:05]",
    ]);
  });

  test("a dead owner pid is taken over by the next session that starts", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    a.kill();
    expect(ws.owner()?.pid).toBe(a.pid);

    const b = ws.startSession();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:05]\nping"]);
    expect(ws.owner()).toEqual({ pid: b.pid, sessionId: b.sessionId, claimedAt: T0 + 5 * MIN });
  });

  test("on owner shutdown the file is removed; a non-owner shutdown leaves it", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    const b = ws.startSession();
    ws.tick();
    b.shutdown();
    expect(ws.owner()?.pid).toBe(a.pid);
    a.shutdown();
    expect(ws.owner()).toBeUndefined();
    expect(ws.loops()).toHaveLength(1);
  });

  test("a session with no UI never claims or fires", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    a.shutdown();
    const p = ws.startSession({ hasUI: false });
    ws.clock.advance(5 * MIN);
    ws.tick();
    p.settle();
    expect(p.fires).toHaveLength(0);
    expect(ws.owner()).toBeUndefined();
  });
});

describe("AC-8 names", () => {
  test("default is loop-<k> with the lowest free k", async () => {
    const s = ws.startSession();
    await s.command("5m a");
    await s.command("5m b");
    await s.command("5m c");
    expect(ws.loops().map((l) => l.name)).toEqual(["loop-1", "loop-2", "loop-3"]);
    await s.command("stop loop-2");
    await s.command("5m d");
    expect(ws.loops().map((l) => l.name)).toEqual(["loop-1", "loop-3", "loop-2"]);
    await s.command("5m e");
    expect(ws.loops().map((l) => l.name)).toEqual(["loop-1", "loop-3", "loop-2", "loop-4"]);
  });

  test("--name sets the name; an existing name rejects with an error and creates nothing", async () => {
    const s = ws.startSession();
    await s.command("5m --name nightly a");
    expect(ws.loops().map((l) => l.name)).toEqual(["nightly"]);
    expect(s.fires[0]?.text).toBe("[loop nightly #1 2026-09-06 10:00]\na");

    s.clearNotices();
    await s.command("10m --name nightly b");
    expect(s.notices).toEqual([{ message: "loop nightly already exists", type: "error" }]);
    expect(ws.loops()).toHaveLength(1);
    expect(ws.loops()[0]?.intervalMs).toBe(5 * MIN);
    expect(s.fires).toHaveLength(1);

    // A default name that collides with an explicit one is skipped, not duplicated.
    await s.command("5m --name loop-1 c");
    await s.command("5m d");
    expect(ws.loops().map((l) => l.name)).toEqual(["nightly", "loop-1", "loop-2"]);
  });

  test("--name rejects names outside [A-Za-z0-9._-] and a missing value", async () => {
    const s = ws.startSession();
    for (const bad of ["--name 'a b' x", "--name a/b x", "--name -x y", "--name"]) {
      s.clearNotices();
      await s.command(`5m ${bad}`);
      expect(s.notices[0]?.type).toBe("error");
    }
    expect(ws.loops()).toHaveLength(0);
  });

  test("flags may come at the head or the tail, before or after the interval, never inside the prompt", async () => {
    const s = ws.startSession();
    await s.command("--name a 5m ping");
    await s.command("5m --name b ping");
    await s.command("--name c ping every 5m");
    await s.command("5m ping --name d");
    await s.command("run the smoke test every 2 hours --name e --max 6");
    await s.command("ping --name f pong 5m");
    expect(ws.loops().map((l) => [l.name, l.prompt, l.max])).toEqual([
      ["a", { kind: "text", text: "ping" }, undefined],
      ["b", { kind: "text", text: "ping" }, undefined],
      ["c", { kind: "text", text: "ping" }, undefined],
      ["d", { kind: "text", text: "ping" }, undefined],
      ["e", { kind: "text", text: "run the smoke test" }, 6],
      ["loop-1", { kind: "text", text: "ping --name f pong" }, undefined],
    ]);
    s.clearNotices();
    await s.command("5m ping --max x");
    expect(s.notices).toEqual([{ message: 'bad --max "x": positive integer', type: "error" }]);
  });
});

describe("AC-9 bounds", () => {
  test("--max n removes the loop after its n-th fire and prints one line", async () => {
    const s = ws.startSession();
    await s.command("5m --max 3 ping");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(ws.loops()).toHaveLength(1);
    s.clearNotices();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual([
      "[loop loop-1 #1 2026-09-06 10:00]",
      "[loop loop-1 #2 2026-09-06 10:05]",
      "[loop loop-1 #3 2026-09-06 10:10]",
    ]);
    expect(ws.loops()).toHaveLength(0);
    expect(s.notices).toEqual([{ message: "loop-1 reached max 3, removed", type: "info" }]);
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(3);
  });

  test("--max 1 is a one-shot", async () => {
    const s = ws.startSession();
    await s.command("5m --max 1 once");
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()).toHaveLength(0);
    expect(s.lastNotice()).toBe("loop-1 reached max 1, removed");
  });

  test("--until HH:mm removes the loop at that time without firing it, and prints one line", async () => {
    const s = ws.startSession();
    await s.command("5m --until 10:12 ping");
    ws.clock.advance(5 * MIN);
    ws.tick();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    s.clearNotices();
    ws.clock.advance(2 * MIN);
    ws.tick();
    expect(ws.loops()).toHaveLength(0);
    expect(s.notices).toEqual([{ message: "loop-1 reached until 2026-09-06 10:12, removed", type: "info" }]);
    ws.clock.advance(3 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(3);
  });

  test("--until at a due instant removes without a fire", async () => {
    const s = ws.startSession();
    await s.command("5m --until 10:05 ping");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()).toHaveLength(0);
  });

  test("--until HH:mm earlier than now means tomorrow; ISO datetimes work; past ISO rejects", async () => {
    const s = ws.startSession();
    await s.command("1h --name tomorrow --until 09:30 a");
    const expected = new Date(T0);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 30, 0, 0);
    expect(ws.loops()[0]?.until).toBe(expected.getTime());
    await s.command("list");
    expect(s.lastNotice()).toBe("tomorrow  active  next 2026-09-06 11:00  every 1h  fires 1  until 2026-09-07 09:30");

    await s.command("1h --name iso --until 2026-09-06T18:00 b");
    expect(ws.loops()[1]?.until).toBe(new Date(2026, 8, 6, 18, 0, 0, 0).getTime());

    s.clearNotices();
    await s.command("1h --name past --until 2026-09-06T09:00 c");
    expect(s.notices).toEqual([{ message: "--until 2026-09-06T09:00 is already in the past", type: "error" }]);
    await s.command("1h --name garbage --until soon d");
    expect(s.notices[1]?.type).toBe("error");
    await s.command("1h --name range --until 25:00 e");
    expect(s.notices[2]?.type).toBe("error");
    expect(ws.loops().map((l) => l.name)).toEqual(["tomorrow", "iso"]);
  });

  test("--max rejects zero, negatives, and non-integers", async () => {
    const s = ws.startSession();
    for (const bad of ["0", "-1", "1.5", "x"]) {
      s.clearNotices();
      await s.command(`5m --max ${bad} x`);
      expect(s.notices[0]?.type).toBe("error");
    }
    expect(ws.loops()).toHaveLength(0);
  });

  test("both bounds together: whichever comes first removes the loop", async () => {
    const s = ws.startSession();
    await s.command("5m --max 5 --until 10:07 ping");
    ws.clock.advance(5 * MIN);
    ws.tick();
    ws.clock.advance(2 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(ws.loops()).toHaveLength(0);
    expect(s.lastNotice()).toBe("loop-1 reached until 2026-09-06 10:07, removed");
  });
});

describe("AC-12 loop state is never read from conversation history", () => {
  test("compaction between two fires changes nothing: counter, due, prompt", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const before = ws.loops();

    // Compaction rewrites the transcript; the extension has no handler for it and reads no entries.
    ws.clock.advance(2 * MIN);
    s.emit("session_before_compact");
    s.emit("session_compact");
    ws.tick();
    expect(ws.loops()).toEqual(before);

    ws.clock.advance(3 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text)).toEqual([
      "[loop loop-1 #1 2026-09-06 10:00]\nping",
      "[loop loop-1 #2 2026-09-06 10:05]\nping",
    ]);
  });

  test("the extension subscribes only to session_start, session_shutdown, agent_settled", () => {
    const s = ws.startSession();
    expect([...s.handlers.keys()].sort()).toEqual(["agent_settled", "session_shutdown", "session_start"]);
  });

  test("any sessionManager member other than getSessionId throws in this harness", () => {
    const s = ws.startSession();
    const sm: { getSessionId(): string; getEntries?: () => unknown } = s.ctx.sessionManager;
    expect(sm.getSessionId()).toBe(s.sessionId);
    expect(() => sm.getEntries).toThrow(/never come from conversation history/);
  });
});
