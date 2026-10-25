import { describe, expect, it } from "vitest";
import { intervalRule, type Job, parseInterval, parseRRule, Scheduler } from "../../src/schedule/scheduler.js";

function setup() {
  let now = 1_000_000;
  const busy = new Set<string>();
  const fired: string[] = [];
  let failNext = false;
  const s = new Scheduler({
    now: () => now,
    busy: (t) => busy.has(t),
    fire: async (j: Job) => {
      if (failNext) {
        failNext = false;
        throw new Error("boom");
      }
      fired.push(`${j.id}@${now}`);
    },
    changed: () => undefined,
  });
  return { s, busy, fired, advance: (ms: number) => (now += ms), at: () => now, fail: () => (failNext = true) };
}

describe("rrule and intervals", () => {
  it("parses the supported subset and rejects the rest instead of ignoring it", () => {
    expect(parseRRule("FREQ=HOURLY;INTERVAL=2;COUNT=3")).toEqual({ freq: "HOURLY", interval: 2, count: 3 });
    expect(parseRRule("RRULE:FREQ=MINUTELY")).toEqual({ freq: "MINUTELY", interval: 1 });
    expect(parseRRule("FREQ=DAILY;BYHOUR=9")).toMatch(/BYHOUR is not supported/);
    expect(parseRRule("FREQ=SECONDLY;INTERVAL=30")).toMatch(/not supported/);
    expect(parseRRule("INTERVAL=5")).toBe("FREQ is required");
  });
  it("reads /loop intervals", () => {
    expect(parseInterval("5m")).toBe(300_000);
    expect(parseInterval("every 2 hours")).toBe(7_200_000);
    expect(parseInterval("90s")).toBe(90_000);
    expect(parseInterval("check")).toBeUndefined();
    expect(intervalRule(7_200_000)).toEqual({ freq: "HOURLY", interval: 2 });
    expect(intervalRule(90_000)).toEqual({ freq: "MINUTELY", interval: 2 });
  });
});

describe("scheduler", () => {
  it("waits for a busy target and collapses missed runs into one", async () => {
    const { s, busy, fired, advance, at } = setup();
    const j = s.add({ owner: "main", target: "main", prompt: "check CI", rule: { freq: "MINUTELY", interval: 1 }, nextAt: at() + 60_000, runMode: "existing" }) as Job;
    busy.add("main");
    advance(60_000 * 3 + 5_000); // three runs were due during a long turn
    await s.tick();
    expect(fired).toEqual([]);
    busy.delete("main");
    await s.tick();
    await s.tick();
    expect(fired).toEqual([`${j.id}@${at()}`]);
    // The next run counts from the fire, not from the missed slots.
    expect(s.jobs.get(j.id)!.nextAt).toBe(at() + 60_000);
  });

  it("ends after COUNT runs and drops one-shots after they fire", async () => {
    const { s, fired, advance, at } = setup();
    s.add({ owner: "main", target: "main", prompt: "x", rule: { freq: "MINUTELY", interval: 1, count: 2 }, nextAt: at(), runMode: "existing", loop: true });
    s.add({ owner: "main", target: "w", prompt: "once", nextAt: at(), runMode: "existing" });
    await s.tick();
    advance(60_000);
    await s.tick();
    advance(60_000);
    await s.tick();
    expect(fired).toHaveLength(3);
    expect(s.jobs.size).toBe(0);
  });

  it("keeps one agent schedule per target but any number of loops", () => {
    const { s, at } = setup();
    const a = s.add({ owner: "main", target: "w", prompt: "a", nextAt: at(), runMode: "existing" }) as Job;
    const b = s.add({ owner: "x", target: "w", prompt: "b", nextAt: at(), runMode: "existing" }) as Job;
    s.add({ owner: "user", target: "main", prompt: "l1", nextAt: at(), runMode: "existing", loop: true });
    s.add({ owner: "user", target: "main", prompt: "l2", nextAt: at(), runMode: "existing", loop: true });
    expect(b.id).toBe(a.id);
    expect(s.agentSchedule("w")?.prompt).toBe("b");
    expect(s.jobs.size).toBe(3);
  });

  it("pauses a schedule whose run fails, and doesn't fire it while paused", async () => {
    const { s, fired, advance, at, fail } = setup();
    const j = s.add({ owner: "main", target: "main", prompt: "x", rule: { freq: "MINUTELY", interval: 1 }, nextAt: at(), runMode: "existing" }) as Job;
    fail();
    await s.tick();
    expect(s.jobs.get(j.id)?.paused).toBe("boom");
    advance(120_000);
    await s.tick();
    expect(fired).toEqual([]);
  });
});
