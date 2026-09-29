// One named test per acceptance criterion in docs/specs/pi-loop.md.
// AC-10 is a grep, AC-11 is a live cache measurement, AC-13 is pi install;
// those are not covered here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { Panel } from "../extensions/pi-loop/index.ts";
import { dialogComponent, editorComponent, TEST_MODEL, Workspace, type Session } from "./mock-pi.ts";

// A fixed instant in local time so header and list output are asserted
// without timezone math: 2026-09-06 10:00 local.
const T0 = new Date(2026, 8, 6, 10, 0, 0, 0).getTime();
const MIN = 60_000;

let ws: Workspace;

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The text listing: what /loop list prints outside the TUI (AC-R8). */
async function listText(s: Session): Promise<string> {
  const was = s.mode;
  s.mode = "rpc";
  s.clearNotices();
  await s.command("list");
  s.mode = was;
  return s.lastNotice();
}

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
    expect(s.fires[0]?.options).toEqual({ deliverAs: "followUp" });
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

  test("at the tail only every/each, a compact form, hourly, or daily counts, so a duration in the prompt stays text", async () => {
    const s = ws.startSession();
    const cases: Array<[string, string, number]> = [
      ["5m summarize the day", "summarize the day", 5 * MIN],
      ["5m check the last 3 days", "check the last 3 days", 5 * MIN],
      ["hourly ping me in a minute", "ping me in a minute", 60 * MIN],
      ["check the build hourly", "check the build", 60 * MIN],
      ["run tests every 2 hours", "run tests", 120 * MIN],
      ["check the build 90m", "check the build", 90 * MIN],
    ];
    for (const [input, prompt, ms] of cases) {
      s.fires.length = 0;
      await s.command(`--name c ${input}`);
      expect([input, s.fires.map((f) => f.text.split("\n").slice(1).join("\n"))]).toEqual([input, [prompt]]);
      expect(ws.loops().at(-1)?.intervalMs).toBe(ms);
      await s.command("stop c");
    }

    for (const bad of ["summarize the day", "check the build 2 hours"]) {
      s.clearNotices();
      await s.command(bad);
      expect(s.notices).toEqual([{ message: "no interval found: say 5m, every 2 hours, hourly, or daily", type: "error" }]);
    }
    expect(ws.loops()).toHaveLength(0);
  });

  test("an and/then left at the start of the prompt by a head phrase is dropped, whole words only", async () => {
    const s = ws.startSession();
    await s.command("1m and then ping");
    expect(s.fires[0]?.text).toBe("[loop loop-1 #1 2026-09-06 10:00]\nping");
    await s.command("1m then-what");
    expect(s.fires[1]?.text).toBe("[loop loop-2 #1 2026-09-06 10:00]\nthen-what");
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

describe("AC-2 a loop fires when due on its schedule, whether or not the agent is busy", () => {
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

  test("a tick due while busy sends once at that tick as a follow-up, and the next due is the next grid point", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.settle();

    s.busy();
    ws.clock.advance(4 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);

    // Due at 10:05; the tick at 10:07 is the first to see it.
    ws.clock.advance(3 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:07]\nping");
    expect(s.fires[1]?.options).toEqual({ deliverAs: "followUp" });
    ws.tick();
    ws.tick();
    s.settle();
    expect(s.fires).toHaveLength(2);

    // Next due is the grid point 10:10, whatever the send time.
    ws.clock.advance(2 * MIN + 59_000);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    ws.clock.advance(1000);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    expect(s.fires[2]?.text).toBe("[loop loop-1 #3 2026-09-06 10:10]\nping");
  });

  test("two loops due in one tick while busy: one fires now, the other on the next tick, earlier due first, none dropped or doubled", async () => {
    const s = ws.startSession();
    await s.command("--name late 5m a");
    ws.clock.advance(MIN);
    await s.command("--name early 10m b");
    s.settle();
    s.fires.length = 0;
    // early is due at 10:10; late at 10:05. Reverse the file order.
    const loops = ws.loops();
    fs.writeFileSync(ws.file(".pi-loop/loops.json"), JSON.stringify([loops[1], loops[0]]));
    s.busy();
    ws.clock.advance(10 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop late #2 2026-09-06 10:11]"]);
    ws.clock.advance(1000);
    ws.tick();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop late #2 2026-09-06 10:11]", "[loop early #2 2026-09-06 10:11]"]);
    expect(s.fires.every((f) => (f.options as { deliverAs?: string }).deliverAs === "followUp")).toBe(true);
    ws.tick();
    s.settle();
    expect(s.fires).toHaveLength(2);
    expect(Object.fromEntries(ws.loops().map((l) => [l.name, l.fires]))).toEqual({ early: 2, late: 2 });
  });

  test("a create while busy queues its first fire at once", async () => {
    const s = ws.startSession();
    s.busy();
    await s.command("5m ping");
    expect(ws.loops()).toHaveLength(1);
    expect(s.fires).toHaveLength(1);
    expect(s.fires[0]?.options).toEqual({ deliverAs: "followUp" });
    s.settle();
    expect(s.fires).toHaveLength(1);
  });
});

describe("AC-15 nothing is sent that pi would reject", () => {
  test("a fire due during compaction is not sent, keeps dueAt and fires, and goes out on the first tick after settle", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.settle();
    const before = ws.loops()[0];
    ws.clock.advance(6 * MIN);
    s.compacting();
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()[0]).toEqual(before);

    ws.clock.advance(MIN);
    s.settle();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:07]\nping");
  });

  test("a loop created while pi compacts is not sent then, and fires once compaction ends and then follows the grid", async () => {
    ws.clock.now = at(10, 7);
    const s = ws.startSession();
    s.compacting();
    await s.command("1h ping");
    ws.tick();
    expect(s.fires).toHaveLength(0);
    expect(ws.loops()[0]).toMatchObject({ fires: 0, dueAt: at(10, 7) });

    ws.clock.now = at(10, 9);
    s.settle();
    expect(s.fires).toHaveLength(1);
    expect(s.fires[0]?.text).toBe("[loop loop-1 #1 2026-09-06 10:09]\nping");
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
  });

  test("a run that starts between the check and pi's own check cannot lose a message: every send carries followUp", async () => {
    const s = ws.startSession();
    await s.command("1m --name a x");
    await s.command("1m --name b y");
    s.settle();
    ws.clock.advance(MIN);
    ws.tick();
    s.busy();
    ws.clock.advance(MIN);
    ws.tick();
    ws.tick();
    s.settle();
    ws.tick();
    expect(s.fires.length).toBeGreaterThanOrEqual(4);
    for (const f of s.fires) expect(f.options).toEqual({ deliverAs: "followUp" });
  });

  test("after a send made while idle, another due loop waits for agent_start, then goes out as a follow-up", async () => {
    const s = ws.startSession();
    s.autoStart = false;
    await s.command("--name a 1m x");
    await s.command("--name b 1m y");
    s.startRun();
    s.settle();
    s.fires.length = 0;

    ws.clock.advance(MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    ws.clock.advance(1000);
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(1);

    s.startRun();
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.options).toEqual({ deliverAs: "followUp" });
  });

  test("the starting guard expires after 10 seconds, so a rejected first send cannot wedge the scheduler", async () => {
    const s = ws.startSession();
    s.autoStart = false;
    await s.command("--name a 1m x");
    await s.command("--name b 1m y");
    s.settle();
    s.fires.length = 0;

    ws.clock.advance(MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    ws.clock.advance(9000);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    ws.clock.advance(1000);
    ws.tick();
    expect(s.fires).toHaveLength(2);
  });

  test("agent_settled clears the starting guard", async () => {
    const s = ws.startSession();
    s.autoStart = false;
    await s.command("--name a 1m x");
    await s.command("--name b 1m y");
    s.settle();
    s.fires.length = 0;

    ws.clock.advance(MIN);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    s.settle();
    expect(s.fires).toHaveLength(2);
  });

  test("a run that ends without agent_settled cannot leave the session marked running: a compaction after it defers the fire", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    await s.flush();
    s.busy();
    // The run is aborted and agent_settled never arrives: pi is idle again.
    s.idle = true;
    s.running = false;
    ws.tick();
    const before = ws.loops()[0];

    ws.clock.advance(6 * MIN);
    s.compacting();
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()[0]).toEqual(before);
  });
});

describe("AC-7 list, stop, pause, resume", () => {
  test("the listing shows name, interval, next due, count, status", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    await s.command("2h --name nightly --max 4 pong");
    expect(await listText(s)).toBe(
      [
        "loop-1  active  next 2026-09-06 10:05  every 5m  fires 1",
        "nightly  active  next 2026-09-06 12:00  every 2h  fires 1  max 4",
      ].join("\n"),
    );
  });

  test("the listing with no loops says so", async () => {
    const s = ws.startSession();
    expect(await listText(s)).toBe("no loops");
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

  test("pause halts firing and keeps the counter; resume sets the next due to the next grid point", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    ws.clock.advance(MIN);
    await s.command("pause loop-1");
    expect(await listText(s)).toBe("loop-1  paused  next -  every 5m  fires 1");

    ws.clock.advance(20 * MIN);
    ws.tick();
    s.settle();
    expect(s.fires).toHaveLength(1);

    // Resume at 10:21: nothing fires now; next due is the grid point 10:25.
    await s.command("resume loop-1");
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(await listText(s)).toBe("loop-1  active  next 2026-09-06 10:25  every 5m  fires 1");
    ws.clock.advance(4 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:25]\nping");
  });

  test("pause of a paused loop and resume of an active loop are errors", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.clearNotices();
    await s.command("resume loop-1");
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toBe("loop-1 is not paused; /loop pause loop-1 pauses it");
    await s.command("pause loop-1");
    s.clearNotices();
    await s.command("pause loop-1");
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toBe("loop-1 is already paused; /loop resume loop-1 resumes it");
  });
});

describe("AC-3 @file prompt source is re-read at every fire", () => {
  test("only a prompt that is one @<path> token is a file; @ followed by more words is text", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "from the file\n");
    await s.command("5m @alice please review the PR");
    await s.command("every 50 min @prompt.md");
    expect(ws.loops().map((l) => l.prompt)).toEqual([
      { kind: "text", text: "@alice please review the PR" },
      { kind: "file", path: "prompt.md" },
    ]);
    expect(s.fires.map((f) => f.text)).toEqual([
      "[loop loop-1 #1 2026-09-06 10:00]\n@alice please review the PR",
      "[loop loop-2 #1 2026-09-06 10:00]\nfrom the file",
    ]);
  });

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
    expect(await listText(s)).toMatch(/^loop-1  active  next 2026-09-06 10:10  every 5m  fires 1  error: prompt file prompt\.md: .*ENOENT/);

    // The loop is alive: the file comes back and the next fire is #2 with no error shown.
    fs.writeFileSync(ws.file("prompt.md"), "v2");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.text).toBe("[loop loop-1 #2 2026-09-06 10:10]\nv2");
    expect(await listText(s)).toBe("loop-1  active  next 2026-09-06 10:15  every 5m  fires 1".replace("fires 1", "fires 2"));
  });

  test("an empty file at fire time is a skip with its own error", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "   \n");
    await s.command("5m @prompt.md");
    expect(s.fires).toHaveLength(0);
    expect(await listText(s)).toMatch(/error: prompt file prompt\.md is empty$/);
  });
});

describe("AC-4 state lives in <cwd>/.pi-loop/loops.json and survives a restart", () => {
  test("a loops.json that is not JSON is an error that says to fix or delete it", async () => {
    fs.mkdirSync(ws.file(".pi-loop"), { recursive: true });
    fs.writeFileSync(ws.file(".pi-loop/loops.json"), "{not json");
    const s = ws.startSession();
    s.clearNotices();
    await s.command("list");
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]?.type).toBe("error");
    expect(s.lastNotice()).toStartWith(`${ws.file(".pi-loop/loops.json")}: `);
    expect(s.lastNotice()).toEndWith(", fix or delete it");
  });

  test("a loops.json written with the first schema (interval: \"2m\") loads, fires, and is rewritten as intervalMs", async () => {
    fs.mkdirSync(ws.file(".pi-loop"), { recursive: true });
    fs.writeFileSync(
      ws.file(".pi-loop/loops.json"),
      JSON.stringify([{ name: "loop-1", interval: "2m", prompt: { kind: "text", text: "say hello" }, dueAt: T0, fires: 5, paused: false }]),
    );
    const s = ws.startSession();
    expect(await listText(s)).toBe("loop-1  active  next 2026-09-06 10:00  every 2m  fires 5");
    // Taking the loops over sends nothing and puts the loop on its grid.
    ws.tick();
    expect(s.fires).toHaveLength(0);
    ws.clock.advance(2 * MIN);
    ws.tick();
    expect(s.fires.map((f) => f.text)).toEqual(["[loop loop-1 #6 2026-09-06 10:02]\nsay hello"]);
    expect(ws.loops()).toEqual([
      { name: "loop-1", intervalMs: 2 * MIN, prompt: { kind: "text", text: "say hello" }, dueAt: T0 + 4 * MIN, fires: 6, paused: false },
    ]);
  });

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
    expect(await listText(b)).toBe(
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
    // Taking over sends nothing for the 10:05 point; the loop waits for 10:10.
    ws.clock.advance(4 * MIN);
    ws.tick();
    expect(b.fires).toHaveLength(0);
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:10]\nping"]);
  });
});

describe("AC-5 no catch-up: grid points missed while pi is not running are skipped", () => {
  test("many missed points send nothing; the loop waits for the next grid point after taking over", async () => {
    const a = ws.startSession();
    await a.command("45m ping");
    ws.clock.advance(10 * MIN);
    a.kill();

    // Back at 12:40: three points were missed (10:30, 11:15, 12:00).
    ws.clock.advance(150 * MIN);
    const b = ws.startSession();
    expect(b.fires).toHaveLength(0);
    b.busy();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    b.settle();
    ws.tick();
    expect(b.fires).toHaveLength(0);

    // The next point is 12:45.
    expect(await listText(b)).toBe("loop-1  active  next 2026-09-06 12:45  every 45m  fires 1");
    ws.clock.advance(4 * MIN);
    ws.tick();
    expect(b.fires).toHaveLength(0);
    ws.clock.advance(MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 12:45]\nping"]);
  });

  test("a loop not yet due on resume waits for its grid point", async () => {
    const a = ws.startSession();
    await a.command("45m ping");
    ws.clock.advance(10 * MIN);
    a.shutdown();
    ws.clock.advance(10 * MIN);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    ws.clock.advance(10 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:30]\nping"]);
  });
});

describe("AC-6 one owner session per cwd", () => {
  test("owner.json holds {pid, sessionId, claimedAt}; only the owner fires; the other shows owned by pid", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    expect(ws.owner()).toEqual({ pid: a.pid, sessionId: a.sessionId, claimedAt: T0 });

    const b = ws.startSession();
    expect(await listText(b)).toBe(`loop-1  owned by pid ${a.pid}  next 2026-09-06 10:05  every 5m  fires 1`);

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
    expect(b.fires).toHaveLength(0);
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(b.fires.map((f) => f.text)).toEqual(["[loop loop-1 #2 2026-09-06 10:10]\nping"]);
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

  test("rpc, print, and json sessions never claim, fire, or tick, whatever their hasUI", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    a.shutdown();
    for (const mode of ["rpc", "print", "json"] as const) {
      for (const hasUI of [true, false]) {
        const p = ws.startSession({ mode, hasUI });
        expect(ws.tickers.get(p.pid)).toBeUndefined();
        for (let i = 0; i < 3; i++) {
          ws.clock.advance(5 * MIN);
          ws.tick();
        }
        p.settle();
        expect(p.fires).toHaveLength(0);
        expect(ws.owner()).toBeUndefined();
        p.shutdown();
      }
    }
    expect(ws.loops().map((l) => l.fires)).toEqual([1]);
  });

  test("an rpc /loop creates the loop and fires nothing; a TUI session started afterwards claims and fires it", async () => {
    const r = ws.startSession({ mode: "rpc", hasUI: true });
    await r.command("5m x");
    ws.tick();
    r.settle();
    expect(ws.loops().map((l) => [l.name, l.fires])).toEqual([["loop-1", 0]]);
    expect(r.fires).toHaveLength(0);
    expect(ws.owner()).toBeUndefined();
    const t = ws.startSession();
    ws.tick();
    expect(t.fires.map((f) => f.text)).toEqual(["[loop loop-1 #1 2026-09-06 10:00]\nx"]);
    expect(ws.owner()).toEqual({ pid: t.pid, sessionId: t.sessionId, claimedAt: T0 });
    expect(r.fires).toHaveLength(0);
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
    expect(s.notices).toEqual([{ message: "loop nightly already exists; pick another --name or /loop stop nightly", type: "error" }]);
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

  test("tail flags are read before the interval, so a flag value is never taken for an interval", async () => {
    const s = ws.startSession();
    await s.command("every day summarize the repo --name daily");
    await s.command("check --name x every 5m");
    expect(ws.loops().map((l) => [l.name, l.intervalMs, l.prompt])).toEqual([
      ["daily", 1440 * MIN, { kind: "text", text: "summarize the repo" }],
      ["x", 5 * MIN, { kind: "text", text: "check" }],
    ]);
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
    expect(await listText(s)).toBe("tomorrow  active  next 2026-09-06 11:00  every 1h  fires 1  until 2026-09-07 09:30");

    await s.command("1h --name iso --until 2026-09-06T18:00 b");
    expect(ws.loops()[1]?.until).toBe(new Date(2026, 8, 6, 18, 0, 0, 0).getTime());

    s.clearNotices();
    await s.command("1h --name past --until 2026-09-06T09:00 c");
    expect(s.notices).toEqual([{ message: "--until 2026-09-06T09:00 is already in the past; give a later time", type: "error" }]);
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

  test("the extension subscribes only to session_start, session_shutdown, agent_start, agent_settled", () => {
    const s = ws.startSession();
    expect([...s.handlers.keys()].sort()).toEqual(["agent_settled", "agent_start", "session_shutdown", "session_start"]);
  });

  test("any sessionManager member other than getSessionId throws in this harness", () => {
    const s = ws.startSession();
    const sm: { getSessionId(): string; getEntries?: () => unknown } = s.ctx.sessionManager;
    expect(sm.getSessionId()).toBe(s.sessionId);
    expect(() => sm.getEntries).toThrow(/never come from conversation history/);
  });
});

// docs/specs/pi-loop-status.md

const HINT = " · → to manage";

describe("AC-S1 the owner line reads counts and the next fire", () => {
  test("<a> active loop(s)[, <p> paused] · next <earliest active> <HH:mm>; all paused drops next", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    await s.command("1m --name idle c");
    await s.command("pause idle");
    ws.clock.advance(5000);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops, 1 paused · next fast 10:05${HINT}`);

    await s.command("resume idle");
    ws.tick();
    expect(s.status()).toBe(`  3 active loops · next idle 10:01${HINT}`);

    await s.command("stop idle");
    await s.command("stop slow");
    expect(s.status()).toBe(`  1 active loop · next fast 10:05${HINT}`);

    await s.command("2h --name slow a");
    ws.clock.advance(5000);
    await s.command("pause fast");
    await s.command("pause slow");
    expect(s.status()).toBe(`  2 paused loops${HINT}`);
    await s.command("stop slow");
    expect(s.status()).toBe(`  1 paused loop${HINT}`);
  });
});

describe("AC-S2 a fire pulses for five seconds", () => {
  test("fired <name> #<fires> replaces next, counts and hint stay, then next returns", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    ws.clock.advance(5000);
    ws.tick();
    await s.command("5m --name fast b");
    expect(s.status()).toBe(`  2 active loops · fired fast #1${HINT}`);
    ws.clock.advance(4999);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops · fired fast #1${HINT}`);
    ws.clock.advance(1);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops · next fast 10:05${HINT}`);

    ws.clock.advance(5 * MIN - 5000);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops · fired fast #2${HINT}`);
  });

  test("a second fire inside the five seconds replaces the pulse", async () => {
    const s = ws.startSession();
    await s.command("5m --name a x");
    ws.clock.advance(2000);
    await s.command("5m --name b y");
    expect(s.status()).toBe(`  2 active loops · fired b #1${HINT}`);
    ws.clock.advance(3000);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops · fired b #1${HINT}`);
    ws.clock.advance(2000);
    ws.tick();
    expect(s.status()).toBe(`  2 active loops · next a 10:05${HINT}`);
  });
});

describe("AC-S3 due while the fire is deferred", () => {
  test("an overdue active loop whose fire compaction defers reads due <name> with no time, then fires after settle", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    ws.clock.advance(5000);
    ws.tick();
    expect(s.status()).toBe(`  1 active loop · next loop-1 10:05${HINT}`);
    s.settle();
    s.compacting();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.status()).toBe(`  1 active loop · due loop-1${HINT}`);
    ws.clock.advance(60_000);
    ws.tick();
    expect(s.status()).toBe(`  1 active loop · due loop-1${HINT}`);
    s.settle();
    expect(s.status()).toBe(`  1 active loop · fired loop-1 #2${HINT}`);
  });
});

describe("AC-S4 a non-owner line", () => {
  test("reads <n> loop(s) · owned by pid <pid> · hint, never says active, carries no error suffix", async () => {
    const a = ws.startSession();
    fs.writeFileSync(ws.file("a.md"), "a");
    await a.command("5m ping");
    await a.command("5m --name p @a.md");
    await a.command("pause p");
    fs.rmSync(ws.file("a.md"));
    await a.command("resume p");
    ws.clock.advance(5 * MIN);
    ws.tick();
    await a.flush();
    ws.tick();
    expect(ws.loops().some((l) => l.lastError !== undefined)).toBe(true);
    const b = ws.startSession();
    ws.tick();
    expect(b.status()).toBe(`  2 loops · owned by pid ${a.pid}${HINT}`);
    await a.command("stop p");
    ws.tick();
    expect(b.status()).toBe(`  1 loop · owned by pid ${a.pid}${HINT}`);
    expect(b.status()).not.toMatch(/active/);
  });
});

describe("AC-S5 error suffix", () => {
  test("one loop with a last error adds · 1 error before the hint; two add · 2 errors", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("a.md"), "a");
    fs.writeFileSync(ws.file("b.md"), "b");
    await s.command("5m --name a @a.md");
    await s.command("5m --name b @b.md");
    await s.command("2h --name c text");
    fs.rmSync(ws.file("a.md"));
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.status()).toBe(`  3 active loops · next b 10:05 · 1 error${HINT}`);
    fs.rmSync(ws.file("b.md"));
    ws.tick();
    ws.clock.advance(5000);
    ws.tick();
    expect(s.status()).toBe(`  3 active loops · next a 10:10 · 2 errors${HINT}`);
  });
});

describe("AC-S6 no loops removes the widget", () => {
  test("stop of the last loop removes it and drops its pulse; a --max fire pulses without the hint, then removes it", async () => {
    const s = ws.startSession();
    expect(s.widgets).toHaveLength(0);
    await s.command("5m ping");
    expect(s.status()).toBe(`  1 active loop · fired loop-1 #1${HINT}`);
    await s.command("stop loop-1");
    expect(s.status()).toBeUndefined();
    expect(s.widgets[s.widgets.length - 1]).toEqual({ key: "pi-loop", factory: undefined, placement: undefined });

    await s.command("5m --max 1 once");
    expect(s.status()).toBe("  fired loop-1 #1");
    ws.clock.advance(4000);
    ws.tick();
    expect(s.status()).toBe("  fired loop-1 #1");
    ws.clock.advance(1000);
    ws.tick();
    expect(s.status()).toBeUndefined();
    expect(s.widgets[s.widgets.length - 1]?.factory).toBeUndefined();
  });

  test("stop of a loop other than the one pulsing keeps the pulse", async () => {
    const s = ws.startSession();
    await s.command("2h --name a x");
    ws.clock.advance(5000);
    ws.tick();
    await s.command("5m --name b y");
    await s.command("stop a");
    expect(s.status()).toBe(`  1 active loop · fired b #1${HINT}`);
  });
});

describe("AC-S7 requestRender only when the text changes", () => {
  test("ten idle ticks with nothing changing make no setWidget and no requestRender call", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    ws.clock.advance(5000);
    ws.tick();
    const widgets = s.widgets.length;
    const renders = s.requestRenders;
    for (let i = 0; i < 10; i++) {
      ws.clock.advance(1000);
      ws.tick();
    }
    expect(s.widgets.length).toBe(widgets);
    expect(s.requestRenders).toBe(renders);
    expect(s.status()).toBe(`  1 active loop · next loop-1 10:05${HINT}`);
  });
});

describe("AC-S8 commands update the line in the same call", () => {
  test("create, pause, resume, stop each render without a tick", async () => {
    const s = ws.startSession();
    await s.command("2h --name a x");
    ws.clock.advance(5000);
    ws.tick();
    const seen: Array<string | undefined> = [];
    await s.command("5m --name b y");
    seen.push(s.status());
    await s.command("pause b");
    seen.push(s.status());
    await s.command("resume b");
    seen.push(s.status());
    await s.command("stop b");
    seen.push(s.status());
    expect(seen).toEqual([
      `  2 active loops · fired b #1${HINT}`,
      `  1 active loop, 1 paused · fired b #1${HINT}`,
      `  2 active loops · fired b #1${HINT}`,
      `  1 active loop · next a 12:00${HINT}`,
    ]);
  });
});

describe("AC-S9 the line is a muted label, a plain joiner, and one dim detail", () => {
  const label = (text: string) => `<muted>${text}</muted>`;
  const detail = (text: string) => `<dim>${text}</dim>`;

  test("steady: muted count, plain joiner, dim next clause and hint in one segment", async () => {
    const s = ws.startSession();
    await s.command("5m --name fast a");
    await s.command("1h --name p b");
    await s.command("pause p");
    ws.clock.advance(5000);
    ws.tick();
    expect(s.styled()).toBe(`  ${label("1 active loop, 1 paused")} · ${detail("next fast 10:05 · → to manage")}`);
  });

  test("due: the due clause is in the dim detail", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.settle();
    s.compacting();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.styled()).toBe(`  ${label("1 active loop")} · ${detail("due loop-1 · → to manage")}`);
  });

  test("fired pulse: the fired clause is in the dim detail, not bold", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    expect(s.styled()).toBe(`  ${label("1 active loop")} · ${detail("fired loop-1 #1 · → to manage")}`);
  });

  test("all paused: muted count, plain joiner, dim hint alone", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    ws.clock.advance(5000);
    await s.command("pause loop-1");
    expect(s.styled()).toBe(`  ${label("1 paused loop")} · ${detail("→ to manage")}`);
  });

  test("non-owner: muted count, dim owner clause and hint", async () => {
    const a = ws.startSession();
    await a.command("5m ping");
    const b = ws.startSession();
    ws.tick();
    expect(b.styled()).toBe(`  ${label("1 loop")} · ${detail(`owned by pid ${a.pid} · → to manage`)}`);
  });

  test("error: the suffix sits inside the dim detail before the hint, with a next clause and with a pulse", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("a.md"), "a");
    await s.command("5m --name a @a.md");
    await s.command("2h --name b text");
    fs.rmSync(ws.file("a.md"));
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.styled()).toBe(`  ${label("2 active loops")} · ${detail("next a 10:10 · 1 error · → to manage")}`);
    await s.command("1m --name c now");
    expect(s.styled()).toBe(`  ${label("3 active loops")} · ${detail("fired c #1 · 1 error · → to manage")}`);
  });

  test("pulse only: no loops remain after --max; the fired clause is the muted label alone", async () => {
    const s = ws.startSession();
    await s.command("5m --name once --max 1 ping");
    expect(s.styled()).toBe(`  ${label("fired once #1")}`);
  });

  test("the widget paints with the theme its factory is given", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const factory = s.widgets[0]?.factory;
    if (!factory) throw new Error("no widget registered");
    const other = { fg: (color: string, text: string) => `[${color}]${text}`, bold: (text: string) => `*${text}` };
    const line = factory({ requestRender() {} }, other).render(200)[0];
    expect(line).toBe(`  [muted]1 active loop · [dim]fired loop-1 #1 · → to manage`);
  });
});

describe("AC-S11 the line is one below-editor widget, redrawn through requestRender", () => {
  test("registered once when the first loop appears, redrawn through tui.requestRender while loops remain, removed and registered again", async () => {
    const s = ws.startSession();
    expect(s.widgets).toHaveLength(0);
    await s.command("2h --name a x");
    expect(s.widgets).toHaveLength(1);
    expect(s.widgets[0]?.key).toBe("pi-loop");
    expect(typeof s.widgets[0]?.factory).toBe("function");
    expect(s.widgets[0]?.placement).toBe("belowEditor");
    expect(s.requestRenders).toBe(0);

    ws.clock.advance(5000);
    ws.tick();
    await s.command("5m --name b y");
    await s.command("pause b");
    await s.command("resume b");
    await s.command("stop b");
    expect(s.widgets).toHaveLength(1);
    expect(s.requestRenders).toBe(5);
    expect(s.status()).toBe(`  1 active loop · next a 12:00${HINT}`);

    await s.command("stop a");
    expect(s.widgets).toHaveLength(2);
    expect(s.widgets[1]?.factory).toBeUndefined();

    await s.command("5m --name c z");
    expect(s.widgets).toHaveLength(3);
    expect(s.widgets[2]?.placement).toBe("belowEditor");
    expect(s.status()).toBe(`  1 active loop · fired c #1${HINT}`);
  });
});

describe("AC-S12 every rendered line fits its width", () => {
  test("lines are cut to the given width with pi-tui's ellipsis", async () => {
    const a = ws.startSession();
    fs.writeFileSync(ws.file("a.md"), "a");
    await a.command("5m --name a-rather-long-loop-name @a.md");
    await a.command("5m --name b text");
    fs.rmSync(ws.file("a.md"));
    ws.clock.advance(5 * MIN);
    ws.tick();
    const factory = a.widgets[a.widgets.length - 1]?.factory;
    if (!factory) throw new Error("no widget registered");
    const ansi = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
    const widget = factory({ requestRender() {} }, ansi);
    const full = widget.render(200);
    expect(full).toHaveLength(1);
    expect(stripAnsi(full[0] ?? "")).toBe(`  2 active loops · next b 10:05 · 1 error${HINT}`);
    for (let width = 1; width <= 80; width++) {
      const lines = widget.render(width);
      expect(lines).toHaveLength(1);
      expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
    }
    expect(stripAnsi(widget.render(20)[0] ?? "")).toBe("  2 active loops ...");
  });
});

describe("AC-S10 the fire header displays as a plain line", () => {
  test("a fired message is stored plain and displayed as the one line <name> #<n> · <time>; the prompt is not shown", async () => {
    const s = ws.startSession();
    await s.command("5m --name nightly check the build\nthen report");
    const stored = s.fires[0]?.text ?? "";
    expect(stored).toBe("[loop nightly #1 2026-09-06 10:00]\ncheck the build\nthen report");
    expect(s.display(stored)).toBe("nightly #1 · 2026-09-06 10:00");
  });

  test("assistant text, a plain user message, and a header past the first line are untouched", async () => {
    const s = ws.startSession();
    const header = "[loop loop-1 #7 2026-09-07 02:48]\nping";
    expect(s.display(header, "assistant")).toBe(header);
    expect(s.display(header, "assistant-thinking")).toBe(header);
    expect(s.display("ping")).toBe("ping");
    expect(s.display("note:\n" + header)).toBe("note:\n" + header);
    expect(s.display("[loop bad name #7 2026-09-07 02:48]\nping")).toBe("[loop bad name #7 2026-09-07 02:48]\nping");
  });
});

// docs/specs/pi-loop-roster.md

/** Script the detail panel: each time it opens, record its plain lines and press the next key. */
function panel(s: Session, keys: string[]): string[][] {
  const seen: string[][] = [];
  s.customImpl = (p) => {
    seen.push(p.render(60).map((l) => l.replace(/<\/?[a-zA-Z]+>/g, "").trimEnd()));
    p.handleInput?.(keys.shift() ?? "\x1b");
  };
  return seen;
}

const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const ENTER = "\r";
/** ↓ released, in the Kitty keyboard protocol's event-type form: pi-tui's isKeyRelease recognizes it and matchesKey still reads it as down. */
const DOWN_RELEASE = "\x1b[1;1:3B";
/** → released, in the same form. */
const RIGHT_RELEASE = "\x1b[1;1:3C";
const ROSTER_HEADER = "  loops · ↑↓/jk select · enter open · esc back";

/**
 * A listener that plays pi-subagents' roster (src/tui/fleet-status.ts handleKey): with an empty
 * editor that has focus, down or left opens it and is consumed; while it is open, down, up, j, k,
 * Enter and Esc are its own; any other key closes it and passes. It follows pi-loop's listener, as
 * the settings order does, or goes ahead of it when `first` is set.
 */
function fleetRoster(s: Session, first = false) {
  const state = { active: false, selected: 0, seen: [] as string[] };
  const listener = (data: string): { consume?: boolean } | undefined => {
    const focused = s.focused as { getText?: unknown; setText?: unknown } | undefined;
    if (typeof focused?.getText !== "function" || typeof focused.setText !== "function") {
      state.active = false;
      return undefined;
    }
    if (!state.active) {
      if ((data !== DOWN && data !== LEFT) || s.editorText !== "") return undefined;
      state.active = true;
      state.selected = 0;
      state.seen.push(data);
      return { consume: true };
    }
    state.seen.push(data);
    if (data === DOWN || data === "j") {
      state.selected = Math.min(2, state.selected + 1);
      return { consume: true };
    }
    if (data === UP || data === "k") {
      if (state.selected === 0) state.active = false;
      else state.selected -= 1;
      return { consume: true };
    }
    if (data === ESC) {
      state.active = false;
      return { consume: true };
    }
    if (data === ENTER) {
      if (state.selected === 0) state.active = false;
      return { consume: true };
    }
    state.active = false;
    return undefined;
  };
  if (first) s.inputListeners.unshift(listener);
  else s.inputListeners.push(listener);
  return state;
}

describe("AC-R1 right on an empty, focused editor opens the roster; down and left stay with the next listener", () => {
  test("right opens it with the first row selected and is consumed", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    const line = s.status();
    expect(s.press(RIGHT)).toBe(true);
    expect(s.status()?.split("\n").slice(0, 2)).toEqual([ROSTER_HEADER, "  › slow        active   next 12:00  every 2h  #1"]);
    expect(s.press(ESC)).toBe(true);
    expect(s.status()).toBe(line);
    expect(s.press(RIGHT)).toBe(true);
    expect(s.status()?.split("\n")[1]).toBe("  › slow        active   next 12:00  every 2h  #1");
    expect(s.editorKeys).toEqual([]);
  });

  test("down and left with a closed roster are not consumed and open nothing", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const line = s.status();
    const renders = s.requestRenders;
    expect(s.press(DOWN)).toBe(false);
    expect(s.press(LEFT)).toBe(false);
    expect(s.editorKeys).toEqual([DOWN, LEFT]);
    expect(s.status()).toBe(line);
    expect(s.requestRenders).toBe(renders);
  });

  test("in the chain [pi-loop, a listener that opens on down or left]: down and left reach it, right is consumed by pi-loop", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const line = s.status();
    const other: string[] = [];
    s.inputListeners.push((data) => {
      if (data === DOWN || data === LEFT) {
        other.push(data);
        return { consume: true };
      }
      return undefined;
    });
    expect(s.press(DOWN)).toBe(true);
    expect(s.press(LEFT)).toBe(true);
    expect(other).toEqual([DOWN, LEFT]);
    expect(s.status()).toBe(line);
    expect(s.press(RIGHT)).toBe(true);
    expect(other).toEqual([DOWN, LEFT]);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
  });

  test("with the roster open, left collapses it and reaches the next listener, which activates; right collapses and passes too; down stays with the roster", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    const line = s.status();
    const other: string[] = [];
    s.inputListeners.push((data) => {
      other.push(data);
      return data === LEFT ? { consume: true } : undefined;
    });
    s.press(RIGHT);
    expect(s.press(LEFT)).toBe(true);
    expect(other).toEqual([LEFT]);
    expect(s.status()).toBe(line);
    s.press(RIGHT);
    expect(s.press(RIGHT)).toBe(false);
    expect(other).toEqual([LEFT, RIGHT]);
    expect(s.status()).toBe(line);
    s.press(RIGHT);
    expect(s.press(DOWN)).toBe(true);
    expect(other).toEqual([LEFT, RIGHT]);
    expect(s.status()?.split("\n")[2]?.startsWith("  › fast")).toBe(true);
  });

  test("the pulse-only line has no loops behind it: right passes through and nothing opens", async () => {
    const s = ws.startSession();
    await s.command("5m --max 1 once");
    expect(s.status()).toBe("  fired loop-1 #1");
    expect(s.press(RIGHT)).toBe(false);
    expect(s.editorKeys).toEqual([RIGHT]);
    expect(s.status()).toBe("  fired loop-1 #1");
  });

  test("a non-empty editor, a dialog with focus, no loops, or a key release: the key passes through and nothing opens", async () => {
    const empty = ws.startSession();
    expect(empty.press(RIGHT)).toBe(false);
    expect(empty.editorKeys).toEqual([RIGHT]);
    empty.shutdown();

    const s = ws.startSession();
    await s.command("5m ping");
    const line = s.status();
    const renders = s.requestRenders;

    s.editorText = "draft";
    expect(s.press(RIGHT)).toBe(false);
    s.editorText = " ";
    expect(s.press(RIGHT)).toBe(false);
    s.editorText = "";

    s.focused = dialogComponent();
    expect(s.press(RIGHT)).toBe(false);
    s.focused = null;
    expect(s.press(RIGHT)).toBe(false);
    s.focused = undefined;
    expect(s.press(RIGHT)).toBe(false);

    s.focused = editorComponent();
    expect(s.press(RIGHT_RELEASE)).toBe(false);

    expect(s.editorKeys).toEqual([RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT_RELEASE]);
    expect(s.status()).toBe(line);
    expect(s.requestRenders).toBe(renders);
    expect(s.press(RIGHT)).toBe(true);
  });

  test("typing keys the editor owns pass through untouched while the roster is closed: j, k, h, up (history), down, left, Enter", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const line = s.status();
    for (const key of ["j", "k", "h", UP, DOWN, LEFT, ENTER]) expect(s.press(key)).toBe(false);
    expect(s.editorKeys).toEqual(["j", "k", "h", UP, DOWN, LEFT, ENTER]);
    expect(s.status()).toBe(line);
    expect(s.press(RIGHT)).toBe(true);
  });

  test("a tui with no focus getter counts as not focused: the roster fails closed", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const factory = s.widgets[0]?.factory;
    if (!factory) throw new Error("no widget registered");
    const plain = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    factory({ requestRender() {} }, plain);
    expect(s.press(RIGHT)).toBe(false);
    expect(s.editorKeys).toEqual([RIGHT]);
    factory({ requestRender() {}, getFocusedComponent: editorComponent }, plain);
    expect(s.press(RIGHT)).toBe(true);
  });
});

describe("AC-R2 the roster draws a header and one row per loop", () => {
  test("header, then marker, name, status, next, interval, fires per row, in state-file order", async () => {
    const a = ws.startSession();
    await a.command("2h --name slow a");
    await a.command("5m --name fast b");
    await a.command("pause fast");
    a.press(RIGHT);
    expect(a.status()).toBe(
      [ROSTER_HEADER, "  › slow        active   next 12:00  every 2h  #1", "    fast        paused   next -      every 5m  #1"].join("\n"),
    );
    const b = ws.startSession();
    ws.tick();
    b.press(RIGHT);
    expect(b.status()?.split("\n")[1]).toBe(`  › slow        owned by pid ${a.pid}  next 12:00  every 2h  #1`);
  });

  test("colors: loops muted, rest of the header dim, marker accent, status by state, everything else default", async () => {
    const a = ws.startSession();
    await a.command("2h --name slow a");
    await a.command("5m --name fast b");
    await a.command("pause fast");
    a.press(RIGHT);
    expect(a.styled()).toBe(
      [
        "  <muted>loops</muted> <dim>· ↑↓/jk select · enter open · esc back</dim>",
        "  <accent>›</accent> slow        <success>active</success>   next 12:00  every 2h  #1",
        "    fast        <dim>paused</dim>   next -      every 5m  #1",
      ].join("\n"),
    );
    const b = ws.startSession();
    ws.tick();
    b.press(RIGHT);
    b.press(DOWN);
    expect(b.styled()?.split("\n").slice(1)).toEqual([
      `    slow        <muted>owned by pid ${a.pid}</muted>  next 12:00  every 2h  #1`,
      `  <accent>›</accent> fast        <dim>paused</dim>             next -      every 5m  #1`,
    ]);
  });

  test("columns line up: the name column fits the longest name, 10 to 16 wide, a longer name cut to 15 and …; the status column fits the longest status", async () => {
    const a = ws.startSession();
    await a.command("2h --name nightly-build x");
    await a.command("5m --name a y");
    a.press(RIGHT);
    expect(a.status()?.split("\n").slice(1)).toEqual([
      "  › nightly-build  active   next 12:00  every 2h  #1",
      "    a              active   next 10:05  every 5m  #1",
    ]);
    a.press(ESC);
    await a.command("1h --name sixteen-chars-ok z");
    await a.command("1h --name seventeen-chars-x w");
    await a.command("pause a");
    a.press(RIGHT);
    expect(a.status()?.split("\n").slice(1)).toEqual([
      "  › nightly-build     active   next 12:00  every 2h  #1",
      "    a                 paused   next -      every 5m  #1",
      "    sixteen-chars-ok  active   next 11:00  every 1h  #1",
      "    seventeen-chars…  active   next 11:00  every 1h  #1",
    ]);
    const b = ws.startSession();
    ws.tick();
    b.press(RIGHT);
    expect(b.status()?.split("\n").slice(1)).toEqual([
      `  › nightly-build     owned by pid ${a.pid}  next 12:00  every 2h  #1`,
      "    a                 paused             next -      every 5m  #1",
      `    sixteen-chars-ok  owned by pid ${a.pid}  next 11:00  every 1h  #1`,
      `    seventeen-chars…  owned by pid ${a.pid}  next 11:00  every 1h  #1`,
    ]);
  });

  test("at most 8 rows show; the window scrolls to keep the selection in view", async () => {
    const s = ws.startSession();
    for (let i = 0; i < 10; i++) await s.command(`1h --name l${i} x`);
    const names = () => (s.status() ?? "").split("\n").slice(1).map((l) => l.slice(2, 7).trim());
    s.press(RIGHT);
    expect(names()).toEqual(["› l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
    for (let i = 0; i < 8; i++) s.press(DOWN);
    expect(names()).toEqual(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "› l8"]);
    s.press("j");
    s.press("j");
    expect(names()).toEqual(["l2", "l3", "l4", "l5", "l6", "l7", "l8", "› l9"]);
    for (let i = 0; i < 9; i++) s.press(UP);
    expect(names()).toEqual(["› l0", "l1", "l2", "l3", "l4", "l5", "l6", "l7"]);
  });

  test("every line fits the render width, cut with pi-tui's ellipsis", async () => {
    const s = ws.startSession();
    await s.command("2h --name a-rather-long-loop-name a");
    await s.command("5m --name b b");
    s.press(RIGHT);
    const factory = s.widgets[s.widgets.length - 1]?.factory;
    if (!factory) throw new Error("no widget registered");
    const ansi = { fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
    const widget = factory({ requestRender() {} }, ansi);
    expect(widget.render(200).map(stripAnsi)).toEqual([
      ROSTER_HEADER,
      "  › a-rather-long-l…  active   next 12:00  every 2h  #1",
      "    b                 active   next 10:05  every 5m  #1",
    ]);
    for (let width = 1; width <= 80; width++) {
      const lines = widget.render(width);
      expect(lines).toHaveLength(3);
      for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(width);
    }
    expect(stripAnsi(widget.render(20)[1] ?? "")).toBe("  › a-rather-long...");
  });
});

describe("AC-R3 keys on the open roster move, collapse, or pass through", () => {
  async function three(): Promise<Session> {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("1h --name b y");
    await s.command("1h --name c z");
    return s;
  }
  const selected = (s: Session) => (s.status() ?? "").split("\n").find((l) => l.startsWith("  › "))?.slice(4, 5);

  test("down or j moves down and stops at the last row; up or k moves up; up or k on the first row collapses; all consumed; one redraw per change", async () => {
    const s = await three();
    const line = s.status();
    const r0 = s.requestRenders;
    expect(s.press(RIGHT)).toBe(true);
    expect(s.requestRenders).toBe(r0 + 1);
    expect(s.press("j")).toBe(true);
    expect(selected(s)).toBe("b");
    expect(s.press(DOWN)).toBe(true);
    expect(selected(s)).toBe("c");
    const r1 = s.requestRenders;
    expect(s.press("j")).toBe(true);
    expect(s.press(DOWN)).toBe(true);
    expect(selected(s)).toBe("c");
    expect(s.requestRenders).toBe(r1);
    expect(s.press("k")).toBe(true);
    expect(selected(s)).toBe("b");
    expect(s.press(UP)).toBe(true);
    expect(selected(s)).toBe("a");
    const r2 = s.requestRenders;
    expect(s.press("k")).toBe(true);
    expect(s.status()).toBe(line);
    expect(s.requestRenders).toBe(r2 + 1);
    expect(s.press(RIGHT)).toBe(true);
    expect(s.press(UP)).toBe(true);
    expect(s.status()).toBe(line);
    expect(s.editorKeys).toEqual([]);
  });

  test("Esc collapses and is consumed", async () => {
    const s = await three();
    const line = s.status();
    s.press(RIGHT);
    s.press(DOWN);
    expect(s.press(ESC)).toBe(true);
    expect(s.status()).toBe(line);
    expect(s.editorKeys).toEqual([]);
    expect(s.press(RIGHT)).toBe(true);
    expect(selected(s)).toBe("a");
  });

  test("any other key collapses and reaches the editor unchanged: h is typed, tab passes", async () => {
    const s = await three();
    const line = s.status();
    s.press(RIGHT);
    expect(s.press("h")).toBe(false);
    expect(s.status()).toBe(line);
    s.press(RIGHT);
    expect(s.press("\t")).toBe(false);
    expect(s.status()).toBe(line);
    expect(s.editorKeys).toEqual(["h", "\t"]);
  });

  test("a key arriving while the editor has lost focus collapses the roster and passes through", async () => {
    const s = await three();
    const line = s.status();
    s.press(RIGHT);
    s.focused = dialogComponent();
    expect(s.press(DOWN)).toBe(false);
    expect(s.status()).toBe(line);
    expect(s.editorKeys).toEqual([DOWN]);
  });

  test("a key release passes through and leaves the roster as it is", async () => {
    const s = await three();
    s.press(RIGHT);
    const open = s.status();
    expect(s.press(DOWN_RELEASE)).toBe(false);
    expect(s.status()).toBe(open);
    expect(s.editorKeys).toEqual([DOWN_RELEASE]);
  });

  test("ticks with nothing changing leave the open roster alone", async () => {
    const s = await three();
    ws.clock.advance(5000);
    ws.tick();
    s.press(RIGHT);
    const open = s.status();
    expect(open?.startsWith(ROSTER_HEADER)).toBe(true);
    const renders = s.requestRenders;
    for (let i = 0; i < 5; i++) {
      ws.clock.advance(1000);
      ws.tick();
    }
    expect(s.status()).toBe(open);
    expect(s.requestRenders).toBe(renders);
  });
});

/** The name on the roster's selected row; undefined while the roster is closed. */
function selectedName(s: Session): string | undefined {
  return (s.status() ?? "").split("\n").find((l) => l.startsWith("  › "))?.slice(4).split(" ")[0];
}

/** Hold every panel open instead of answering it: press its keys later, count how many opened. */
function hold(s: Session): { key(data: string): void; opened(): number } {
  const held: Panel[] = [];
  s.customImpl = (p) => {
    held.push(p);
  };
  return {
    key: (data) => held[held.length - 1]?.handleInput?.(data),
    opened: () => held.length,
  };
}

const STOP_MESSAGE = "The loop is removed. Its fires so far stay in the transcript.";

describe("AC-R4 Enter on the roster opens the selected loop's detail panel", () => {
  test("border, blank, name, blank, fields, blank, hint, blank, border; text and @path prompts; consumed; back on the same row", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("p.md"), "x");
    await s.command("5m --name first ping");
    await s.command("2h --name nightly --max 10 --until 23:30 @p.md");
    const seen = panel(s, [ESC, ESC]);
    s.press(RIGHT);
    expect(s.press(ENTER)).toBe(true);
    await s.flush();
    expect(selectedName(s)).toBe("first");
    s.press("j");
    expect(s.press(ENTER)).toBe(true);
    await s.flush();
    expect(seen).toEqual([
      [
        "─".repeat(60),
        "",
        " first",
        "",
        " interval   5m",
        " prompt     ping",
        " next       2026-09-06 10:05",
        " fires      1",
        " status     active",
        "",
        " p pause  x stop  escape/ctrl+c back",
        "",
        "─".repeat(60),
      ],
      [
        "─".repeat(60),
        "",
        " nightly",
        "",
        " interval   2h",
        " prompt     @p.md",
        " next       2026-09-06 12:00",
        " fires      1",
        " status     active",
        " max        10",
        " until      2026-09-06 23:30",
        "",
        " p pause  x stop  escape/ctrl+c back",
        "",
        "─".repeat(60),
      ],
    ]);
    expect(s.status()?.split("\n")[0]).toBe(ROSTER_HEADER);
    expect(selectedName(s)).toBe("nightly");
    expect(s.editorKeys).toEqual([]);
  });

  test("hint keys dim and descriptions muted; a paused loop says p resume; an error shows", async () => {
    const s = ws.startSession();
    fs.writeFileSync(ws.file("p.md"), "x");
    await s.command("5m @p.md");
    fs.rmSync(ws.file("p.md"));
    ws.clock.advance(5 * MIN);
    ws.tick();
    await s.command("pause loop-1");
    let styled: string[] = [];
    s.customImpl = (p) => {
      styled = p.render(60);
      p.handleInput?.("\x03");
    };
    s.press(RIGHT);
    s.press(ENTER);
    await s.flush();
    expect(styled[0]).toBe(`<border>${"─".repeat(60)}</border>`);
    expect(styled[2]).toBe(" <accent><b>loop-1</b></accent>");
    expect(styled.find((l) => l.includes("status"))).toBe(" <muted>status    </muted> paused");
    expect(styled.find((l) => l.includes("error"))).toMatch(/^ <muted>error     <\/muted> prompt file p\.md: .*ENOENT/);
    expect(styled.find((l) => l.includes("resume"))).toBe(
      " <dim>p</dim><muted> resume</muted>  <dim>x</dim><muted> stop</muted>  <dim>escape/ctrl+c</dim><muted> back</muted>",
    );
    expect(styled[styled.length - 1]).toBe(`<border>${"─".repeat(60)}</border>`);
  });

  test("while the panel is open every key passes, the widget draws nothing through focus loss and ticks, a second Enter opens nothing, and the roster returns on close", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("1h --name b y");
    await s.command("1h --name c z");
    const p = hold(s);
    s.press(RIGHT);
    s.press("j");
    const open = s.status();
    const widgets = s.widgets.length;
    expect(s.press(ENTER)).toBe(true);
    expect(p.opened()).toBe(1);
    expect(s.status()).toBe("");
    const renders = s.requestRenders;
    s.focused = dialogComponent();
    for (const key of [ENTER, DOWN, "j", ESC, "h"]) expect(s.press(key)).toBe(false);
    ws.clock.advance(1000);
    ws.tick();
    expect(p.opened()).toBe(1);
    expect(s.status()).toBe("");
    expect(s.requestRenders).toBe(renders);
    expect(s.widgets).toHaveLength(widgets);
    p.key(ESC);
    s.focused = editorComponent();
    await s.flush();
    expect(s.status()).toBe(open);
    expect(selectedName(s)).toBe("b");
    expect(s.press("j")).toBe(true);
    expect(selectedName(s)).toBe("c");
  });

  test("when the loop is gone by the time the panel closes, the row now at its index is selected, or the last row", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("1h --name b y");
    await s.command("1h --name c z");
    const p = hold(s);
    s.press(RIGHT);
    s.press("j");
    s.press(ENTER);
    await s.command("stop b");
    p.key(ESC);
    await s.flush();
    expect(selectedName(s)).toBe("c");
    s.press(ENTER);
    await s.command("stop c");
    p.key(ESC);
    await s.flush();
    expect(selectedName(s)).toBe("a");
  });

  test("every loop gone while the panel is open removes the widget, and closing the panel draws nothing", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    const p = hold(s);
    s.press(RIGHT);
    s.press(ENTER);
    expect(s.status()).toBe("");
    await s.command("stop a");
    expect(s.status()).toBeUndefined();
    expect(s.widgets[s.widgets.length - 1]?.factory).toBeUndefined();
    const widgets = s.widgets.length;
    p.key(ESC);
    await s.flush();
    expect(s.status()).toBeUndefined();
    expect(s.widgets).toHaveLength(widgets);
    expect(s.press(RIGHT)).toBe(false);
  });

  test("a failing panel flow is logged, never left unhandled, and the roster works again", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      s.confirmImpl = () => {
        throw new Error("boom");
      };
      const seen = panel(s, ["x", ESC]);
      s.press(RIGHT);
      s.press(ENTER);
      await s.flush();
      expect(errors).toEqual(["pi-loop: boom"]);
      expect(selectedName(s)).toBe("loop-1");
      expect(s.press(ENTER)).toBe(true);
      await s.flush();
      expect(seen).toHaveLength(2);
      expect(ws.loops()).toHaveLength(1);
    } finally {
      console.error = original;
    }
  });

  test("a redraw that throws after the panel closes is logged, never left unhandled, and the roster works again", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.join(" "));
    };
    try {
      panel(s, ["p"]);
      s.press(RIGHT);
      s.press(ENTER);
      s.failNextRender = new Error("render boom");
      await s.flush();
      expect(ws.loops()[0]?.paused).toBe(true);
      expect(errors).toEqual(["pi-loop: render boom"]);
      expect(s.press(ENTER)).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test("a panel that outlives its session acts on nothing and draws nothing: shutdown, or a new session start", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const p = hold(s);
    s.press(RIGHT);
    s.press(ENTER);
    s.shutdown();
    const widgets = s.widgets.length;
    s.clearNotices();
    p.key("p");
    await s.flush();
    expect(ws.loops()[0]?.paused).toBe(false);
    expect(s.notices).toEqual([]);
    expect(s.widgets).toHaveLength(widgets);

    const t = ws.startSession();
    t.confirmImpl = () => {
      t.emit("session_start");
      return true;
    };
    const q = hold(t);
    t.press(RIGHT);
    t.press(ENTER);
    q.key("x");
    await t.flush();
    expect(t.confirms).toHaveLength(1);
    expect(ws.loops()).toHaveLength(1);
    expect(t.notices.map((n) => n.message)).not.toContain("stopped loop-1");
  });
});

describe("AC-R5 p on the panel pauses or resumes and returns to the roster", () => {
  test("applies at once, prints the typed command's notice, and the roster shows the new status on the same row", async () => {
    const s = ws.startSession();
    await s.command("5m --name a ping");
    await s.command("1h --name b pong");
    ws.clock.advance(5000);
    ws.tick();
    s.clearNotices();
    const seen = panel(s, ["p", "p"]);
    s.press(RIGHT);
    s.press("j");
    s.press(ENTER);
    await s.flush();
    expect(s.notices.map((n) => n.message)).toEqual(["paused b"]);
    expect(ws.loops()[1]?.paused).toBe(true);
    expect(s.status()?.split("\n")[2]).toBe(`  › ${"b".padEnd(10)}  paused   next -      every 1h  #1`);
    s.press(ENTER);
    await s.flush();
    expect(s.notices.map((n) => n.message)).toEqual(["paused b", "resumed b, next 2026-09-06 11:00"]);
    expect(s.status()?.split("\n")[2]).toBe(`  › ${"b".padEnd(10)}  active   next 11:00  every 1h  #1`);
    expect(seen.map((lines) => lines.find((l) => l.startsWith(" p ")))).toEqual([" p pause  x stop  escape/ctrl+c back", " p resume  x stop  escape/ctrl+c back"]);
  });

  test("the action goes to the panel's loop by name after the rows shift, and a loop gone meanwhile gets the typed command's error", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("1h --name b y");
    await s.command("1h --name c z");
    const p = hold(s);
    s.press(RIGHT);
    s.press("j");
    s.press(ENTER);
    await s.command("stop a");
    p.key("p");
    await s.flush();
    expect(ws.loops().map((l) => [l.name, l.paused])).toEqual([
      ["b", true],
      ["c", false],
    ]);
    expect(selectedName(s)).toBe("b");

    s.press(ENTER);
    await s.command("stop b");
    s.clearNotices();
    p.key("p");
    await s.flush();
    expect(s.notices).toEqual([{ message: "no loop named b; /loop list shows the names", type: "error" }]);
    expect(ws.loops().map((l) => [l.name, l.paused])).toEqual([["c", false]]);
    expect(selectedName(s)).toBe("c");
  });
});

describe("AC-R6 x on the panel asks first", () => {
  test("no changes nothing; yes removes the loop and returns to the roster; stopping the last loop closes it and removes the status line", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("1h --name b y");
    const answers = [false, true, true];
    s.confirmImpl = () => answers.shift() ?? false;
    panel(s, ["x", "x", "x"]);
    s.press(RIGHT);
    s.press("j");
    s.press(ENTER);
    await s.flush();
    expect(ws.loops().map((l) => l.name)).toEqual(["a", "b"]);
    expect(selectedName(s)).toBe("b");
    s.clearNotices();
    s.press(ENTER);
    await s.flush();
    expect(s.notices.map((n) => n.message)).toEqual(["stopped b"]);
    expect(ws.loops().map((l) => l.name)).toEqual(["a"]);
    expect(s.status()?.split("\n")[0]).toBe(ROSTER_HEADER);
    expect(selectedName(s)).toBe("a");
    s.press(ENTER);
    await s.flush();
    expect(s.confirms).toEqual([
      { title: "Stop b?", message: STOP_MESSAGE },
      { title: "Stop b?", message: STOP_MESSAGE },
      { title: "Stop a?", message: STOP_MESSAGE },
    ]);
    expect(ws.loops()).toEqual([]);
    expect(s.status()).toBeUndefined();
    expect(s.widgets[s.widgets.length - 1]?.factory).toBeUndefined();
    expect(s.press(RIGHT)).toBe(false);
  });
});

describe("AC-R7 escape and ctrl+c on the panel return to the roster; other keys are ignored", () => {
  test("stray keys leave the panel open and change nothing; escape and ctrl+c go back", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    const before = fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8");
    s.clearNotices();
    const p = hold(s);
    s.press(RIGHT);
    const open = s.status();
    for (const back of [ESC, "\x03"]) {
      s.press(ENTER);
      for (const stray of ["q", "\n", ENTER, "P", "X"]) p.key(stray);
      await s.flush();
      expect(s.press(DOWN)).toBe(false);
      p.key(back);
      await s.flush();
      expect(s.status()).toBe(open);
      expect(s.press(DOWN)).toBe(true);
    }
    expect(p.opened()).toBe(2);
    expect(s.confirms).toEqual([]);
    expect(s.notices).toEqual([]);
    expect(fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8")).toBe(before);
  });
});

describe("AC-R8 bare /loop and /loop list open the roster in TUI mode and print the text listing elsewhere", () => {
  test("TUI: both forms open the roster exactly as right does, first row selected, writing nothing; keys work afterwards", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    const line = s.status();
    s.press(RIGHT);
    const roster = s.status();
    expect(roster).toBe(
      [ROSTER_HEADER, "  › slow        active   next 12:00  every 2h  #1", "    fast        active   next 10:05  every 5m  #1"].join("\n"),
    );
    s.press(ESC);
    const file = ws.file(".pi-loop/loops.json");
    const before = fs.readFileSync(file);
    for (const args of ["", "list"]) {
      s.clearNotices();
      await s.command(args);
      expect(s.status()).toBe(roster);
      expect(s.notices).toEqual([]);
      expect(s.press("j")).toBe(true);
      expect(selectedName(s)).toBe("fast");
      expect(s.press(ESC)).toBe(true);
      expect(s.status()).toBe(line);
    }
    expect(s.editorKeys).toEqual([]);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  test("TUI: an open roster resets to the first row, and the rows come from the state file, not the last tick", async () => {
    const s = ws.startSession();
    await s.command("1h --name a x");
    await s.command("stop a");
    const other = ws.startSession();
    await other.command("1h --name b y");
    await s.command("");
    expect(s.status()?.split("\n").slice(1)).toEqual([`  › ${"b".padEnd(10)}  active   next 10:00  every 1h  #0`]);
    await s.command("1h --name c z");
    s.press("j");
    expect(selectedName(s)).toBe("c");
    await other.command("1h --name d w");
    await s.command("list");
    expect(s.status()?.split("\n").slice(1)).toEqual([
      `  › ${"b".padEnd(10)}  active   next 11:00  every 1h  #1`,
      `    ${"c".padEnd(10)}  active   next 10:00  every 1h  #0`,
      `    ${"d".padEnd(10)}  active   next 10:00  every 1h  #0`,
    ]);
  });

  test("TUI with no loops: the notice no loops, no widget, nothing open", async () => {
    const s = ws.startSession();
    for (const args of ["", "list"]) {
      s.clearNotices();
      await s.command(args);
      expect(s.notices).toEqual([{ message: "no loops", type: "info" }]);
      expect(s.widgets).toEqual([]);
      expect(s.status()).toBeUndefined();
    }
    await s.command("5m ping");
    expect(s.status()).toBe(`  1 active loop · fired loop-1 #1${HINT}`);
  });

  test("TUI without a started session, reachable only after shutdown: the command fails loudly instead of opening nothing", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    s.shutdown();
    s.clearNotices();
    await expect(s.command("")).rejects.toThrow("pi-loop: no session to open the roster in");
    expect(s.notices).toEqual([]);
  });

  test("rpc (with a UI), json, print: both forms print one text line per loop, or no loops, and open nothing", async () => {
    const a = ws.startSession();
    fs.writeFileSync(ws.file("p.md"), "x");
    await a.command("5m --name a --max 3 --until 23:30 @p.md");
    fs.rmSync(ws.file("p.md"));
    ws.clock.advance(5 * MIN);
    ws.tick();
    await a.command("1h --name b pong");
    await a.command("pause b");
    a.shutdown();
    const modes = [
      ["rpc", true],
      ["json", false],
      ["print", false],
    ] as const;
    for (const [mode, hasUI] of modes) {
      const p = ws.startSession({ mode, hasUI });
      const line = p.status();
      for (const args of ["", "list"]) {
        p.clearNotices();
        await p.command(args);
        expect(p.notices).toHaveLength(1);
        expect(p.notices[0]?.type).toBe("info");
        const [first, second, ...rest] = p.lastNotice().split("\n");
        expect(first).toMatch(/^a  active  next 2026-09-06 10:10  every 5m  fires 1  max 3  until 2026-09-06 23:30  error: prompt file p\.md: .*ENOENT/);
        expect(second).toBe("b  paused  next -  every 1h  fires 1");
        expect(rest).toEqual([]);
        expect(p.status()).toBe(line);
        expect(p.press("j")).toBe(false);
      }
      p.shutdown();
    }
    const s = ws.startSession();
    await s.command("stop a");
    await s.command("stop b");
    s.shutdown();
    for (const [mode, hasUI] of modes) {
      const p = ws.startSession({ mode, hasUI });
      for (const args of ["", "list"]) {
        p.clearNotices();
        await p.command(args);
        expect(p.notices).toEqual([{ message: "no loops", type: "info" }]);
        expect(p.status()).toBeUndefined();
      }
      p.shutdown();
    }
  });
});

describe("AC-R9 the open roster follows live changes by the next tick", () => {
  test("a fire and another session's change update the rows; the selection stays on its loop by name", async () => {
    const s = ws.startSession();
    await s.command("5m --name a x");
    await s.command("1h --name b y");
    s.press(RIGHT);
    s.press("j");
    const other = ws.startSession();
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(s.status()?.split("\n")[1]).toBe(`    ${"a".padEnd(10)}  active   next 10:10  every 5m  #2`);
    await other.command("pause b");
    ws.tick();
    expect(s.status()?.split("\n")[2]).toBe(`  › ${"b".padEnd(10)}  paused   next -      every 1h  #1`);
    await other.command("stop a");
    ws.tick();
    expect(s.status()?.split("\n").slice(1)).toEqual([`  › ${"b".padEnd(10)}  paused   next -      every 1h  #1`]);
  });

  test("a removed selection moves to the row now at its index, or the last row; no loops closes the roster and removes the line", async () => {
    const s = ws.startSession();
    for (const name of ["a", "b", "c", "d"]) await s.command(`1h --name ${name} x`);
    await s.command("5m --name m --max 2 y");
    s.press(RIGHT);
    s.press("j");
    s.press("j");
    expect(selectedName(s)).toBe("c");
    const other = ws.startSession();
    await other.command("stop c");
    ws.tick();
    expect(selectedName(s)).toBe("d");
    s.press("j");
    expect(selectedName(s)).toBe("m");
    ws.clock.advance(5 * MIN);
    ws.tick();
    expect(ws.loops().map((l) => l.name)).toEqual(["a", "b", "d"]);
    expect(selectedName(s)).toBe("d");
    for (const name of ["a", "b", "d"]) await other.command(`stop ${name}`);
    ws.tick();
    expect(s.status()).toBe("  fired m #2");
    ws.clock.advance(5000);
    ws.tick();
    expect(s.status()).toBeUndefined();
    expect(s.widgets[s.widgets.length - 1]?.factory).toBeUndefined();
  });
});

describe("AC-R10 opening and closing the roster writes nothing", () => {
  test("the state file is byte-identical after open, moves, and Esc", async () => {
    const s = ws.startSession();
    await s.command("5m ping");
    await s.command("1h --name b x");
    const file = ws.file(".pi-loop/loops.json");
    const before = fs.readFileSync(file);
    const mtime = fs.statSync(file).mtimeMs;
    expect(s.press(RIGHT)).toBe(true);
    expect(s.press("j")).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
  });
});

describe("AC-R11 the input listener lives from TUI session start to shutdown", () => {
  test("one subscription per TUI session start, even with no loops; a second start replaces it; shutdown removes it and the widget", async () => {
    const s = ws.startSession();
    expect(s.inputListeners).toHaveLength(1);
    s.emit("session_start");
    expect(s.inputListeners).toHaveLength(1);
    await s.command("5m ping");
    const widgets = s.widgets.length;
    s.shutdown();
    expect(s.inputListeners).toHaveLength(0);
    expect(s.widgets).toHaveLength(widgets + 1);
    expect(s.widgets[s.widgets.length - 1]).toEqual({ key: "pi-loop", factory: undefined, placement: undefined });
  });

  test("a shutdown with no widget registered removes nothing", () => {
    const s = ws.startSession();
    expect(s.inputListeners).toHaveLength(1);
    s.shutdown();
    expect(s.inputListeners).toHaveLength(0);
    expect(s.widgets).toEqual([]);
  });

  test("no subscription in rpc, json, or print mode", () => {
    expect(ws.startSession({ mode: "tui" }).inputListeners).toHaveLength(1);
    for (const mode of ["rpc", "json", "print"] as const) {
      const s = ws.startSession({ mode });
      expect(s.inputListeners).toHaveLength(0);
      s.shutdown();
    }
  });
});

// docs/specs/pi-loop-naming.md: a loop created without --name is named by the session's model.

const CHOSEN = /^[a-z0-9][a-z0-9._-]*$/;
const LONG = "check the open pull requests for stale reviews";

/** A session with a current model, as pi gives one to /loop. */
function modelSession(mode: Session["mode"] = "tui"): Session {
  const s = ws.startSession({ mode });
  s.model = TEST_MODEL;
  return s;
}

/** Create a loop and return its name, the create notice, and how many model calls it made. */
async function create(s: Session, args: string): Promise<{ name: string | undefined; notice: string; calls: number }> {
  const before = s.modelCalls.length;
  s.clearNotices();
  await s.command(args);
  return { name: ws.loops().at(-1)?.name, notice: s.lastNotice(), calls: s.modelCalls.length - before };
}

describe("AC-R12 beside a roster that behaves like pi-subagents'", () => {
  test("pi-loop first: down and left open the other roster and pi-loop's stays closed; right opens pi-loop's", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const closed = s.status();
    const other = fleetRoster(s);
    expect(s.press(DOWN)).toBe(true);
    expect(other.active).toBe(true);
    expect(s.status()).toBe(closed);
    expect(s.press(ESC)).toBe(true);
    expect(other.active).toBe(false);
    expect(s.press(LEFT)).toBe(true);
    expect(other.active).toBe(true);
    expect(other.seen).toEqual([DOWN, ESC, LEFT]);
    expect(s.status()).toBe(closed);
    s.press(ESC);
    expect(s.press(RIGHT)).toBe(true);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(other.active).toBe(false);
  });

  test("pi-loop first: while the other roster is open, down, up, j, k, Enter and Esc reach it and pi-loop stays closed", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const closed = s.status();
    const other = fleetRoster(s);
    s.press(DOWN);
    for (const key of [DOWN, "j", UP, "k"]) {
      expect(s.press(key)).toBe(true);
      expect(s.status()).toBe(closed);
    }
    expect(other.seen).toEqual([DOWN, DOWN, "j", UP, "k"]);
    expect(s.press(ENTER)).toBe(true);
    expect(other.active).toBe(false);
    expect(s.status()).toBe(closed);
    expect(s.press(DOWN)).toBe(true);
    expect(other.active).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(other.active).toBe(false);
    expect(s.status()).toBe(closed);
  });

  test("pi-loop first: left inside pi-loop's open roster closes it and opens the other roster", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const closed = s.status();
    const other = fleetRoster(s);
    s.press(RIGHT);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(s.press(LEFT)).toBe(true);
    expect(other.active).toBe(true);
    expect(s.status()).toBe(closed);
  });

  test("pi-loop first: right while the other roster is open also opens pi-loop's roster, which takes the keys first until Esc", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    const closed = s.status();
    const other = fleetRoster(s);
    s.press(DOWN);
    expect(s.press(RIGHT)).toBe(true);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(other.active).toBe(true);
    const seen = [...other.seen];
    expect(s.press(DOWN)).toBe(true);
    expect(other.seen).toEqual(seen);
    expect(s.status()?.split("\n")[2]?.startsWith("  › fast")).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(s.status()).toBe(closed);
    expect(other.active).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(other.active).toBe(false);
  });

  test("the other listener first: right opens pi-loop's roster and j and k move it; down there reaches the other listener first", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    await s.command("5m --name fast b");
    const other = fleetRoster(s, true);
    expect(s.press(RIGHT)).toBe(true);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(other.seen).toEqual([]);
    expect(s.press("j")).toBe(true);
    expect(s.status()?.split("\n")[2]?.startsWith("  › fast")).toBe(true);
    expect(s.press("k")).toBe(true);
    expect(s.status()?.split("\n")[1]?.startsWith("  › slow")).toBe(true);
    expect(other.seen).toEqual([]);
    expect(s.press(DOWN)).toBe(true);
    expect(other.active).toBe(true);
    expect(s.status()?.split("\n")[1]?.startsWith("  › slow")).toBe(true);
  });

  test("the other listener first: left inside pi-loop's open roster also reaches the other listener first; the other then takes Esc before pi-loop's roster", async () => {
    const s = ws.startSession();
    await s.command("2h --name slow a");
    const other = fleetRoster(s, true);
    s.press(RIGHT);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(s.press(LEFT)).toBe(true);
    expect(other.active).toBe(true);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(other.active).toBe(false);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(true);
    expect(s.press(ESC)).toBe(true);
    expect(s.status()?.startsWith(ROSTER_HEADER)).toBe(false);
  });
});

describe("AC-N1 the name is settled before the loop is saved and fired", () => {
  test("the first fire's header, the create notice, and loops.json carry the model's name", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "stale-reviews" };
    await s.command(`5m ${LONG}`);
    expect(s.fires.map((f) => f.text)).toEqual([`[loop stale-reviews #1 2026-09-06 10:00]\n${LONG}`]);
    expect(s.notices).toEqual([{ message: "created stale-reviews, every 5m", type: "info" }]);
    expect(ws.loops().map((l) => l.name)).toEqual(["stale-reviews"]);
  });

  test("while the model is still answering nothing is saved, fired, or announced under a provisional name", async () => {
    const s = modelSession();
    s.modelAnswer = "until-aborted";
    const pending = s.command(`5m ${LONG}`);
    await s.flush();
    expect(ws.loops()).toEqual([]);
    expect(s.fires).toEqual([]);
    expect(s.notices).toEqual([]);
    ws.expireNaming();
    await pending;
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #1 2026-09-06 10:00]"]);
  });
});

describe("AC-N2 the first rule that applies names the loop", () => {
  test("an @file prompt is named after the file, cleaned like an answer, with no model call", async () => {
    const s = modelSession();
    fs.mkdirSync(ws.file("notes"));
    const cases: Array<[string, string]> = [
      ["@prompt.md", "prompt"],
      ["@notes/Daily.md", "daily"],
      ["@weekly-dependency-report.md", "weekly-dependenc"],
      ["@notes/Daily+Log.md", "dailylog"],
      ["@.env", "env"],
    ];
    for (const [token, name] of cases) {
      const made = await create(s, `5m ${token}`);
      expect([token, made.name, made.notice, made.calls]).toEqual([token, name, `created ${name}, every 5m`, 0]);
    }
  });

  test("a text prompt of at most 3 words that makes a valid name of at most 16 characters is used as is, with no model call", async () => {
    const s = modelSession();
    const cases: Array<[string, string]> = [
      ["ping", "ping"],
      ["check build", "check-build"],
      ["Check The Build", "check-the-build"],
    ];
    for (const [prompt, name] of cases) {
      const made = await create(s, `5m ${prompt}`);
      expect([prompt, made.name, made.calls]).toEqual([prompt, name, 0]);
    }
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual([
      "[loop ping #1 2026-09-06 10:00]",
      "[loop check-build #1 2026-09-06 10:00]",
      "[loop check-the-build #1 2026-09-06 10:00]",
    ]);
  });

  test("any other text prompt goes to the model: more than 3 words, longer than 16, or not a valid name", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "named" };
    for (const prompt of [LONG, "check the buildbot", "ping!", "run the test suite"]) {
      const made = await create(s, `5m ${prompt}`);
      expect([prompt, made.calls]).toEqual([prompt, 1]);
      await s.command(`stop ${made.name}`);
    }
  });

  test("--name is taken as typed and the model is never called", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "named" };
    const made = await create(s, `5m --name nightly ${LONG}`);
    expect([made.name, made.notice, made.calls]).toEqual(["nightly", "created nightly, every 5m", 0]);
    expect(s.fires[0]?.text.split("\n")[0]).toBe("[loop nightly #1 2026-09-06 10:00]");
  });
});

describe("AC-N3 the naming call", () => {
  test("goes to the session's model with one user message stating the rule then the prompt, maxTokens 4096, no retries, a 20 s timeout", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "stale-reviews" };
    await s.command(`5m ${LONG}`);
    expect(s.modelCalls).toHaveLength(1);
    const call = s.modelCalls[0];
    expect(call?.model).toBe(TEST_MODEL);
    expect(call?.context.systemPrompt).toBeUndefined();
    expect(call?.context.tools).toBeUndefined();
    expect(call?.context.messages).toHaveLength(1);
    const message = call?.context.messages[0];
    expect(message?.role).toBe("user");
    const content = message?.role === "user" ? message.content : undefined;
    const text = typeof content === "string" ? content : content?.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(text).toContain("1 to 3 lowercase words joined by hyphens, at most 16 characters");
    expect(text).toContain("only");
    expect(text?.endsWith(LONG)).toBe(true);
    expect(call?.options?.maxTokens).toBe(4096);
    expect(call?.options?.maxRetries).toBe(0);
    expect(call?.options?.timeoutMs).toBe(20000);
    expect(call?.options?.signal).toBe(ws.namingDeadlines[0]?.signal);
  });

  test("a reasoning model that reasons 1024 tokens before its answer still names the loop", async () => {
    const s = modelSession();
    s.modelAnswer = { reasoningTokens: 1024, text: "send-greeting" };
    const made = await create(s, `5m ${LONG}`);
    expect([made.name, made.notice]).toEqual(["send-greeting", "created send-greeting, every 5m"]);
  });
});

describe("AC-N4 the model's answer is cleaned into a name", () => {
  test("first non-empty line, lowercased, spaces and underscores to hyphens, other characters dropped, trimmed, cut to 16, trimmed again", async () => {
    const s = modelSession();
    const cases: Array<[string, string]> = [
      ["Stale PR Review\nextra", "stale-pr-review"],
      ["\n  \n  ping-me  \nsecond", "ping-me"],
      ["__Build!!Check__", "buildcheck"],
      ["`deploy`", "deploy"],
      ["Name: nightly.run", "name-nightly.run"],
      [".hidden.", "hidden"],
      ["check-the-open-pull-requests", "check-the-open-p"],
      ["check-the-build-status", "check-the-build"],
      ["Ünïcode Name", "ncode-name"],
    ];
    for (const [answer, name] of cases) {
      s.modelAnswer = { text: answer };
      const made = await create(s, `5m ${LONG}`);
      expect([answer, made.name]).toEqual([answer, name]);
      expect(made.name).toMatch(CHOSEN);
      expect(made.name?.length).toBeLessThanOrEqual(16);
      await s.command(`stop ${made.name}`);
    }
  });
});

describe("AC-N5 no usable name falls back to loop-<k>", () => {
  test("with no current model the name is loop-<k>, the notice is today's, and nothing is called", async () => {
    const s = ws.startSession();
    const made = await create(s, `5m ${LONG}`);
    expect([made.name, made.notice, made.calls]).toEqual(["loop-1", "created loop-1, every 5m", 0]);
    expect((await create(s, "5m ping")).name).toBe("loop-2");
    expect((await create(s, "5m @prompt.md")).name).toBe("loop-3");
  });

  test("an @file name that cleans to nothing gives loop-<k> with today's notice and no call", async () => {
    const s = modelSession();
    const made = await create(s, "5m @+++.md");
    expect([made.name, made.notice, made.calls]).toEqual(["loop-1", "created loop-1, every 5m", 0]);
  });

  test("a throw, an error or abort stop reason, or an answer that cleans to nothing gives loop-<k> and says why", async () => {
    const s = modelSession();
    const cases: Array<[Session["modelAnswer"], string]> = [
      [{ throws: new Error("boom") }, "failed"],
      [{ stopReason: "error" }, "failed"],
      [{ stopReason: "aborted" }, "failed"],
      [{ text: "!!!" }, "gave no usable name"],
      [{ text: " \n\t\n" }, "gave no usable name"],
      [{ text: "--__--" }, "gave no usable name"],
    ];
    for (const [answer, why] of cases) {
      s.modelAnswer = answer;
      const made = await create(s, `5m ${LONG}`);
      expect([why, made.name, made.notice, made.calls]).toEqual([why, "loop-1", `created loop-1, every 5m · naming ${why}`, 1]);
      await s.command("stop loop-1");
    }
    // bun fails the test on an unhandled rejection; let a late one land inside it.
    await s.flush();
  });

  test("a call past 20 seconds is abandoned even when the provider ignores the abort, and its late rejection is handled", async () => {
    const s = modelSession();
    for (const answer of ["never", "until-aborted"] as const) {
      s.modelAnswer = answer;
      const pending = s.command(`5m ${LONG}`);
      await s.flush();
      expect(s.fires).toEqual([]);
      ws.expireNaming();
      await pending;
      expect([answer, s.lastNotice()]).toEqual([answer, "created loop-1, every 5m · naming timed out"]);
      expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #1 2026-09-06 10:00]"]);
      await s.command("stop loop-1");
      s.fires.length = 0;
    }
    // bun fails the test on an unhandled rejection; let a late one land inside it.
    await s.flush();
  });
});

describe("AC-N6 a chosen name already taken gets the lowest free -2, -3", () => {
  test("repeats of a short prompt count up and reuse the lowest free suffix", async () => {
    const s = modelSession();
    await s.command("5m ping");
    await s.command("10m ping");
    await s.command("15m ping");
    expect(ws.loops().map((l) => l.name)).toEqual(["ping", "ping-2", "ping-3"]);
    await s.command("stop ping-2");
    const made = await create(s, "5m ping");
    expect([made.name, made.notice]).toEqual(["ping-2", "created ping-2, every 5m"]);
    expect(s.fires.at(-1)?.text.split("\n")[0]).toBe("[loop ping-2 #1 2026-09-06 10:00]");
  });

  test("the base is cut so the whole name stays within 16 characters, never ending the base in . _ -", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "check-the-open-p" };
    await s.command(`5m ${LONG}`);
    await s.command(`10m ${LONG}`);
    s.modelAnswer = { text: "weekly-report-a" };
    await s.command(`5m ${LONG}`);
    await s.command(`10m ${LONG}`);
    expect(ws.loops().map((l) => l.name)).toEqual(["check-the-open-p", "check-the-open-2", "weekly-report-a", "weekly-report-2"]);
    for (const l of ws.loops()) expect(l.name.length).toBeLessThanOrEqual(16);
  });
});

describe("AC-N7 loops.json is read again after the name is settled", () => {
  test("two creates in flight that the model names alike become x and x-2, both saved and fired once", async () => {
    const s = modelSession();
    s.modelAnswer = { text: "x" };
    await Promise.all([s.command(`5m ${LONG}`), s.command(`10m ${LONG}`)]);
    // The first fire's run has not started when the second create ticks, so the second fire waits for the next tick.
    await s.flush();
    ws.tick();
    expect(ws.loops().map((l) => [l.name, l.intervalMs, l.fires])).toEqual([
      ["x", 5 * MIN, 1],
      ["x-2", 10 * MIN, 1],
    ]);
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop x #1 2026-09-06 10:00]", "[loop x-2 #1 2026-09-06 10:00]"]);
  });

  test("two creates in flight that both time out become loop-1 and loop-2", async () => {
    const s = modelSession();
    s.modelAnswer = "until-aborted";
    const first = s.command(`5m ${LONG}`);
    const second = s.command(`10m ${LONG}`);
    await s.flush();
    ws.expireNaming();
    await Promise.all([first, second]);
    await s.flush();
    ws.tick();
    expect(ws.loops().map((l) => [l.name, l.intervalMs, l.fires])).toEqual([
      ["loop-1", 5 * MIN, 1],
      ["loop-2", 10 * MIN, 1],
    ]);
    // bun fails the test on an unhandled rejection; let a late one land inside it.
    await s.flush();
  });

  test("a stop and a pause made while a create waits on the model are kept by its save", async () => {
    const s = modelSession();
    await s.command("5m --name gone ping");
    await s.command("5m --name held ping");
    s.modelAnswer = "until-aborted";
    const pending = s.command(`5m ${LONG}`);
    await s.flush();
    await s.command("stop gone");
    await s.command("pause held");
    ws.expireNaming();
    await pending;
    expect(ws.loops().map((l) => [l.name, l.paused])).toEqual([
      ["held", true],
      ["loop-1", false],
    ]);
    await s.flush();
  });

  test("a fire made while a create waits on the model keeps its fires and dueAt after the save", async () => {
    const s = modelSession();
    await s.command("5m ping");
    ws.clock.advance(5 * MIN);
    s.modelAnswer = "until-aborted";
    const pending = s.command(`5m ${LONG}`);
    await s.flush();
    ws.tick();
    ws.expireNaming();
    await pending;
    expect(ws.loops().map((l) => [l.name, l.fires, l.dueAt])).toEqual([
      ["ping", 2, T0 + 10 * MIN],
      ["loop-1", 1, T0 + 10 * MIN],
    ]);
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual([
      "[loop ping #1 2026-09-06 10:00]",
      "[loop ping #2 2026-09-06 10:05]",
      "[loop loop-1 #1 2026-09-06 10:05]",
    ]);
    await s.flush();
  });

  test("when the read after the name fails, its error is notified and nothing is created", async () => {
    const s = modelSession();
    s.modelAnswer = "until-aborted";
    const pending = s.command(`5m ${LONG}`);
    await s.flush();
    fs.mkdirSync(ws.file(".pi-loop"), { recursive: true });
    fs.writeFileSync(ws.file(".pi-loop/loops.json"), "not json");
    ws.expireNaming();
    await pending;
    expect(s.notices.map((n) => [n.type, n.message.startsWith(ws.file(".pi-loop/loops.json"))])).toEqual([["error", true]]);
    expect(fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8")).toBe("not json");
    expect(s.fires).toEqual([]);
    await s.flush();
  });
});

describe("AC-N8 the same naming in every mode", () => {
  test("rpc, json, and print sessions name loops as the TUI does", async () => {
    for (const mode of ["rpc", "json", "print"] as const) {
      const s = modelSession(mode);
      s.modelAnswer = { text: "stale-reviews" };
      const short = await create(s, "5m ping");
      const long = await create(s, `5m ${LONG}`);
      expect([mode, short.name, short.calls, long.name, long.notice, long.calls]).toEqual([
        mode,
        "ping",
        0,
        "stale-reviews",
        "created stale-reviews, every 5m",
        1,
      ]);
      await s.command("stop ping");
      await s.command("stop stale-reviews");
      s.shutdown();
    }
  });
});

/** A local time on the test day, 2026-09-06. */
function at(hour: number, minute: number, second = 0): number {
  return new Date(2026, 8, 6, hour, minute, second, 0).getTime();
}

/** Run only one session's tickers, as that session's own timer would. */
function tickOnly(s: Session): void {
  for (const fn of ws.tickers.get(s.pid) ?? []) fn();
}

describe("AC-2 the schedule is a fixed grid on the local clock", () => {
  test("a 1h loop created at 10:07 fires at once and is next due at 11:00; nothing fires at 10:59:59", async () => {
    ws.clock.now = at(10, 7);
    const s = ws.startSession();
    await s.command("1h ping");
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
    s.settle();
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
    ws.clock.now = at(10, 59, 59);
    ws.tick();
    expect(s.fires).toHaveLength(1);
  });

  test("a late tick fires and the next due is the grid point after it: no drift", async () => {
    ws.clock.now = at(10, 7);
    const s = ws.startSession();
    await s.command("1h ping");
    s.settle();
    ws.tick();
    ws.clock.now = at(11, 0, 37);
    ws.tick();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #1 2026-09-06 10:07]", "[loop loop-1 #2 2026-09-06 11:00]"]);
    expect(ws.loops()[0]?.dueAt).toBe(at(12, 0));
    s.settle();
    ws.clock.now = at(12, 0);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    expect(ws.loops()[0]?.dueAt).toBe(at(13, 0));
  });

  test("15m fires at :00 :15 :30 :45", async () => {
    ws.clock.now = at(10, 7);
    const s = ws.startSession();
    await s.command("15m ping");
    s.settle();
    ws.tick();
    const dues: number[] = [];
    for (const [h, m] of [[10, 15], [10, 30], [10, 45], [11, 0]] as const) {
      ws.clock.now = at(h, m);
      ws.tick();
      s.settle();
      dues.push(ws.loops()[0]?.dueAt as number);
    }
    expect(s.fires).toHaveLength(5);
    expect(dues).toEqual([at(10, 30), at(10, 45), at(11, 0), at(11, 15)]);
  });

  test("a fire deferred by compaction across two grid points goes out late; the next due is the first grid point after the send", async () => {
    const s = ws.startSession();
    await s.command("15m ping");
    s.settle();
    ws.tick();
    s.compacting();
    ws.clock.now = at(10, 50);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    expect(ws.loops()[0]?.dueAt).toBe(at(10, 15));
    s.settle();
    expect(s.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #1 2026-09-06 10:00]", "[loop loop-1 #2 2026-09-06 10:50]"]);
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
  });

  test("an unreadable prompt file advances dueAt to the next grid point and records the error", async () => {
    ws.clock.now = at(10, 7);
    const s = ws.startSession();
    fs.writeFileSync(ws.file("prompt.md"), "v1");
    await s.command("15m @prompt.md");
    s.settle();
    fs.rmSync(ws.file("prompt.md"));
    ws.tick();
    ws.clock.now = at(10, 15, 20);
    ws.tick();
    const loop = ws.loops()[0];
    expect(s.fires).toHaveLength(1);
    expect(loop?.fires).toBe(1);
    expect(loop?.dueAt).toBe(at(10, 30));
    expect(loop?.lastError).toMatch(/ENOENT/);
  });
});

describe("AC-7 resume and pause on the grid", () => {
  test("resume at 10:41 of a 1h loop stores 11:00 and fires there", async () => {
    const s = ws.startSession();
    await s.command("1h ping");
    s.settle();
    await s.command("pause loop-1");
    ws.clock.now = at(10, 41);
    await s.command("resume loop-1");
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
    expect(s.lastNotice()).toBe("resumed loop-1, next 2026-09-06 11:00");
    ws.clock.now = at(10, 59, 59);
    ws.tick();
    expect(s.fires).toHaveLength(1);
    ws.clock.now = at(11, 0);
    ws.tick();
    expect(s.fires).toHaveLength(2);
  });

  test("pausing leaves the loop untouched but for paused", async () => {
    const s = ws.startSession();
    await s.command("1h ping");
    s.settle();
    ws.tick();
    const before = ws.loops()[0];
    ws.clock.now = at(10, 41);
    await s.command("pause loop-1");
    expect(ws.loops()[0]).toEqual({ ...before as object, paused: true } as never);
  });
});

describe("AC-5 no catch-up: taking ownership waits for the next grid point", () => {
  test("a restart at 13:20 sends nothing, stores 14:00, and fires at 14:00", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    a.shutdown();
    ws.clock.now = at(13, 20);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    expect(ws.loops()[0]?.dueAt).toBe(at(14, 0));
    expect(ws.loops()[0]?.fires).toBe(1);
    ws.clock.now = at(14, 0);
    ws.tick();
    expect(b.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #2 2026-09-06 14:00]"]);
  });

  test("a takeover from a crashed owner at 13:20 gives the same result", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    a.kill();
    ws.clock.now = at(13, 20);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    expect(ws.loops()[0]?.dueAt).toBe(at(14, 0));
    ws.clock.now = at(14, 0);
    ws.tick();
    expect(b.fires).toHaveLength(1);
  });

  test("a loop with no fire yet still fires at the first tick", async () => {
    ws.clock.now = at(10, 7);
    const r = ws.startSession({ mode: "rpc", hasUI: true });
    await r.command("1h x");
    ws.clock.now = at(13, 20);
    const t = ws.startSession();
    ws.tick();
    expect(t.fires.map((f) => f.text.split("\n")[0])).toEqual(["[loop loop-1 #1 2026-09-06 13:20]"]);
    expect(ws.loops()[0]?.dueAt).toBe(at(14, 0));
  });

  test("a stored off-grid future dueAt from the fixed-delay scheme is snapped at acquisition", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    a.shutdown();
    const stored = ws.loops();
    stored[0]!.dueAt = at(11, 7);
    fs.writeFileSync(ws.file(".pi-loop/loops.json"), JSON.stringify(stored));
    ws.clock.now = at(10, 20);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    expect(ws.loops()[0]?.dueAt).toBe(at(11, 0));
  });

  test("a paused loop is left alone at acquisition", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    await a.command("pause loop-1");
    a.shutdown();
    const before = fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8");
    ws.clock.now = at(13, 20);
    const b = ws.startSession();
    ws.tick();
    expect(b.fires).toHaveLength(0);
    expect(fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8")).toBe(before);
  });

  test("acquisition happens once per ownership: later ticks fire on the stored grid", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    a.shutdown();
    ws.clock.now = at(13, 20);
    const b = ws.startSession();
    ws.tick();
    ws.clock.now = at(14, 0);
    ws.tick();
    b.settle();
    ws.clock.now = at(14, 30);
    ws.tick();
    expect(b.fires).toHaveLength(1);
    expect(ws.loops()[0]?.dueAt).toBe(at(15, 0));
  });

  test("a non-owner tick leaves loops.json byte-identical", async () => {
    const a = ws.startSession();
    await a.command("1h ping");
    const b = ws.startSession();
    const before = fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8");
    ws.clock.now = at(13, 20);
    tickOnly(b);
    tickOnly(b);
    expect(fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8")).toBe(before);
    expect(b.fires).toHaveLength(0);
  });

  test("a paused loop stays as it is across a restart, and its resume lands on the grid", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h ping");
    await a.command("pause loop-1");
    a.shutdown();
    const before = fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8");

    ws.clock.now = at(13, 20);
    const b = ws.startSession();
    ws.tick();
    expect(fs.readFileSync(ws.file(".pi-loop/loops.json"), "utf8")).toBe(before);
    await b.command("resume loop-1");
    expect(ws.loops()[0]?.dueAt).toBe(at(14, 0));
    expect(b.fires).toHaveLength(0);

    ws.clock.now = at(14, 0);
    ws.tick();
    expect(b.fires).toHaveLength(1);
  });

  test("a loop created by a non-owner is fired by the owner without being snapped, then follows the grid", async () => {
    ws.clock.now = at(10, 7);
    const a = ws.startSession();
    await a.command("1h --name first x");
    a.settle();
    const b = ws.startSession();

    ws.clock.now = at(10, 20);
    await b.command("1h --name second other");
    expect(b.fires).toHaveLength(0);
    expect(ws.loops().find((l) => l.name === "second")).toMatchObject({ fires: 0, dueAt: at(10, 20) });

    ws.tick();
    expect(a.fires).toHaveLength(2);
    expect(a.fires[1]?.text).toBe("[loop second #1 2026-09-06 10:20]\nother");
    expect(ws.loops().find((l) => l.name === "second")).toMatchObject({ fires: 1, dueAt: at(11, 0) });
    expect(b.fires).toHaveLength(0);
  });
});

describe("AC-17 a loop keeps at most one fire waiting", () => {
  const headers = (s: Session) => s.fires.map((f) => f.text.split("\n")[0]);
  const stored = (name: string) => ws.loops().find((l) => l.name === name);

  test("a 1m loop with a run that outlasts its interval queues one fire and skips the grid points after it", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    expect(s.fires).toHaveLength(1);
    s.busy();

    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(s.fires[1]?.options).toEqual({ deliverAs: "followUp" });
    expect(stored("loop-1")).toMatchObject({ fires: 2, dueAt: at(10, 2) });
    ws.tick();
    expect(s.fires).toHaveLength(2);

    for (const minute of [2, 3, 4]) {
      ws.clock.now = at(10, minute);
      ws.tick();
      expect(s.fires).toHaveLength(2);
      expect(stored("loop-1")).toMatchObject({ fires: 2, dueAt: at(10, minute + 1) });
    }

    ws.clock.now = at(10, 5);
    s.settle();
    expect(s.fires).toHaveLength(3);
    expect(s.fires[2]?.text).toBe("[loop loop-1 #3 2026-09-06 10:05]\nping");
    expect(stored("loop-1")).toMatchObject({ fires: 3, dueAt: at(10, 6) });
  });

  test("different loops never skip each other: each queues one fire, both skip the next grid point, a later loop still queues", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("--name a 1m x");
    await s.command("--name b 1m y");
    s.fires.length = 0;
    s.busy();

    ws.clock.now = at(10, 1);
    ws.tick();
    expect(headers(s)).toEqual(["[loop a #2 2026-09-06 10:01]"]);
    ws.tick();
    expect(headers(s)).toEqual(["[loop a #2 2026-09-06 10:01]", "[loop b #2 2026-09-06 10:01]"]);

    ws.clock.now = at(10, 2);
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(stored("a")).toMatchObject({ fires: 2, dueAt: at(10, 3) });
    expect(stored("b")).toMatchObject({ fires: 2, dueAt: at(10, 3) });

    await s.command("--name c 1m z");
    expect(headers(s).at(-1)).toBe("[loop c #1 2026-09-06 10:02]");
    expect(s.fires).toHaveLength(3);
    ws.clock.now = at(10, 3);
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(3);
  });

  test("a skip does not use the tick's send: the loop with no waiting fire is sent in the same tick", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("--name a 1m x");
    await s.command("--name b 1m y");
    s.fires.length = 0;
    s.busy();
    await s.command("pause b");

    ws.clock.now = at(10, 1);
    ws.tick();
    expect(headers(s)).toEqual(["[loop a #2 2026-09-06 10:01]"]);
    ws.clock.now = at(10, 1, 30);
    await s.command("resume b");
    expect(stored("b")?.dueAt).toBe(at(10, 2));

    ws.clock.now = at(10, 2);
    ws.tick();
    expect(headers(s)).toEqual(["[loop a #2 2026-09-06 10:01]", "[loop b #2 2026-09-06 10:02]"]);
    expect(stored("a")).toMatchObject({ fires: 2, dueAt: at(10, 3) });
    expect(stored("b")).toMatchObject({ fires: 2, dueAt: at(10, 3) });
  });

  test("skipped grid points do not count toward --max", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m --max 3 ping");
    s.busy();
    for (const minute of [1, 2, 3, 4]) {
      ws.clock.now = at(10, minute);
      ws.tick();
    }
    expect(s.fires).toHaveLength(2);
    expect(stored("loop-1")).toMatchObject({ fires: 2, dueAt: at(10, 5) });

    ws.clock.now = at(10, 5);
    s.settle();
    expect(s.fires).toHaveLength(3);
    expect(ws.loops()).toHaveLength(0);
    expect(s.lastNotice()).toBe("loop-1 reached max 3, removed");
  });

  test("an idle observation clears a mark left by a run that ended without agent_settled", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);

    s.idle = true;
    s.running = false;
    ws.clock.now = at(10, 1, 30);
    ws.tick();
    s.busy();
    ws.clock.now = at(10, 2);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    expect(s.fires[2]?.options).toEqual({ deliverAs: "followUp" });
  });

  test("after the agent settles, a later run lets the loop queue one fire again", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);

    ws.clock.now = at(10, 1, 10);
    s.settle();
    s.busy();
    ws.clock.now = at(10, 2);
    ws.tick();
    expect(s.fires).toHaveLength(3);
    ws.clock.now = at(10, 3);
    ws.tick();
    expect(s.fires).toHaveLength(3);
  });

  test("a skip shows nothing: no notification is raised for a skipped grid point", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);
    const before = s.notices.length;

    for (const minute of [2, 3, 4]) {
      ws.clock.now = at(10, minute);
      ws.tick();
    }
    expect(s.fires).toHaveLength(2);
    expect(s.notices).toHaveLength(before);
    expect(s.status()).toBe(`  1 active loop · next loop-1 10:05${HINT}`);
  });

  test("a loop stopped with a waiting fire leaves no mark for a loop created later under the same name", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("--name a 1m x");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);

    await s.command("stop a");
    await s.command("--name a 1m x");
    expect(s.fires).toHaveLength(3);
    expect(s.fires[2]?.text).toBe("[loop a #1 2026-09-06 10:01]\nx");
    expect(s.fires[2]?.options).toEqual({ deliverAs: "followUp" });
    ws.clock.now = at(10, 2);
    ws.tick();
    expect(s.fires).toHaveLength(3);
  });

  test("a loop removed by --max or --until leaves no mark for a loop created later under the same name", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("--name m 1m --max 2 x");
    await s.command("--name u 1m --until 10:02 y");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    ws.tick();
    expect(ws.loops()).toHaveLength(1);
    expect(s.fires).toHaveLength(4);
    ws.clock.now = at(10, 2);
    ws.tick();
    expect(ws.loops()).toHaveLength(0);

    await s.command("--name m 1m x");
    await s.command("--name u 1m y");
    expect(s.fires).toHaveLength(6);
  });

  test("a skip changes only dueAt in loops.json and never writes lastError", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    const { dueAt: before, ...rest } = stored("loop-1")!;
    ws.clock.now = at(10, 2);
    ws.tick();
    const { dueAt: after, ...restAfter } = stored("loop-1")!;
    expect(before).toBe(at(10, 2));
    expect(after).toBe(at(10, 3));
    expect(restAfter).toEqual(rest);
    expect(restAfter).not.toHaveProperty("lastError");
    expect(s.notices.filter((n) => n.type === "error")).toEqual([]);
  });

  test("compaction neither sends nor skips, and the marks are gone once the run that set them settled", async () => {
    ws.clock.now = at(10, 0);
    const s = ws.startSession();
    await s.command("1m ping");
    s.busy();
    ws.clock.now = at(10, 1);
    ws.tick();
    expect(s.fires).toHaveLength(2);

    // pi compacts only after the run settled, which cleared the mark.
    ws.clock.now = at(10, 1, 10);
    s.settle();
    s.compacting();
    ws.clock.now = at(10, 2);
    const before = stored("loop-1");
    ws.tick();
    ws.tick();
    expect(s.fires).toHaveLength(2);
    expect(stored("loop-1")).toEqual(before);

    s.settle();
    expect(s.fires).toHaveLength(3);
    s.busy();
    ws.clock.now = at(10, 3);
    ws.tick();
    expect(s.fires).toHaveLength(4);
    expect(s.fires[3]?.options).toEqual({ deliverAs: "followUp" });
  });
});
