import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK_MS, Pacer } from "../../src/schedule/pacer.js";
import { type Job, Scheduler } from "../../src/schedule/scheduler.js";
import { loadScheduleSettings } from "../../src/schedule/settings.js";

function setup(fallbackMs = DEFAULT_FALLBACK_MS) {
  let now = 1_000_000;
  const fired: Job[] = [];
  const s = new Scheduler({ now: () => now, busy: () => false, fire: async (j) => void fired.push(j), changed: () => undefined });
  const p = new Pacer(s, { now: () => now, fallbackMs, target: "main", fallbackPrompt: (l) => `fallback: ${l.prompt}` });
  // Fires due jobs and tells the pacer, as the extension's fire hook does.
  const tick = async () => {
    const before = fired.length;
    await s.tick();
    for (const j of fired.slice(before)) p.fired(j);
  };
  const wakeup = (delay = 300_000) => {
    s.add({ owner: "main", target: "main", prompt: "look again", nextAt: now + delay, runMode: "existing" });
    p.wakeupChanged();
  };
  return { s, p, fired, tick, wakeup, advance: (ms: number) => (now += ms), at: () => now };
}

describe("self-paced /loop fallback", () => {
  it("arms one fallback about 20 minutes out when a round sets no wakeup and doesn't stop", () => {
    const { s, p, at } = setup();
    p.start("check CI");
    const r = p.settled({});
    expect(r.outcome).toBe("armed");
    const jobs = [...s.jobs.values()];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ fallback: true, loop: true, target: "main", nextAt: at() + 20 * 60_000, prompt: "fallback: check CI" });
  });

  it("doesn't arm when the agent set its own wakeup", () => {
    const { s, p, wakeup } = setup();
    p.start("check CI");
    wakeup();
    expect(p.settled({}).outcome).toBe("waiting");
    expect([...s.jobs.values()].some((j) => j.fallback)).toBe(false);
  });

  it("cancels a pending fallback when the agent sets a wakeup", () => {
    const { s, p, wakeup } = setup();
    p.start("check CI");
    p.settled({}); // e.g. the user typed something mid-loop and that round set nothing
    wakeup();
    expect([...s.jobs.values()].filter((j) => j.fallback)).toEqual([]);
    expect(p.loop).toBeDefined();
  });

  it("cancels the fallback and ends the loop when the agent stops it", async () => {
    const { s, p, fired, tick, advance } = setup();
    p.start("check CI");
    p.settled({});
    expect(p.stop()).toBe(true); // clear_schedule
    expect(s.jobs.size).toBe(0);
    advance(DEFAULT_FALLBACK_MS);
    await tick();
    expect(fired).toEqual([]);
    expect(p.settled({}).outcome).toBe("idle");
  });

  it("ends the loop when the fallback round doesn't reschedule either, and goes on when it does", async () => {
    const { s, p, fired, tick, advance, wakeup } = setup();
    p.start("check CI");
    p.settled({});
    advance(DEFAULT_FALLBACK_MS);
    await tick();
    expect(fired.map((j) => j.fallback)).toEqual([true]);
    wakeup(); // this fallback round reschedules: the loop goes on
    expect(p.settled({}).outcome).toBe("waiting");
    advance(300_000);
    await tick(); // the agent's wakeup round sets nothing: a fresh fallback
    expect(p.settled({}).outcome).toBe("armed");
    advance(DEFAULT_FALLBACK_MS);
    await tick();
    expect(p.settled({})).toEqual({ outcome: "ended", reason: "the fallback round didn't schedule another" });
    expect(p.loop).toBeUndefined();
    expect(s.jobs.size).toBe(0);
  });

  it("ends on an interrupted or failed round, and with the fallback turned off", () => {
    const a = setup();
    a.p.start("x");
    expect(a.p.settled({ aborted: true }).outcome).toBe("ended");
    a.p.start("x");
    expect(a.p.settled({ failed: "429" })).toEqual({ outcome: "ended", reason: "the round failed: 429" });
    const off = setup(0);
    off.p.start("x");
    expect(off.p.settled({}).outcome).toBe("ended");
    expect(off.s.jobs.size).toBe(0);
  });

  it("ignores rounds when no self-paced loop runs, and doesn't count a /loop interval job as the agent's wakeup", () => {
    const { s, p, at } = setup();
    expect(p.settled({}).outcome).toBe("idle");
    s.add({ owner: "user", target: "main", prompt: "every 5m", rule: { freq: "MINUTELY", interval: 5 }, nextAt: at(), runMode: "existing", loop: true });
    p.start("x");
    expect(p.settled({}).outcome).toBe("armed");
  });
});

describe("schedule settings", () => {
  it("reads schedule.fallbackWakeupMinutes from b4agent.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4-sched-"));
    const path = join(dir, "b4agent.json");
    try {
      expect(loadScheduleSettings(path).fallbackMs).toBe(20 * 60_000);
      writeFileSync(path, JSON.stringify({ schedule: { fallbackWakeupMinutes: 5 } }));
      expect(loadScheduleSettings(path).fallbackMs).toBe(300_000);
      writeFileSync(path, JSON.stringify({ schedule: { fallbackWakeupMinutes: 0 } }));
      expect(loadScheduleSettings(path).fallbackMs).toBe(0);
      writeFileSync(path, JSON.stringify({ schedule: { fallbackWakeupMinutes: 0.01 } }));
      expect(loadScheduleSettings(path).fallbackMs).toBe(5_000);
      const errors: string[] = [];
      writeFileSync(path, JSON.stringify({ schedule: { fallbackWakeupMinutes: "soon" } }));
      expect(loadScheduleSettings(path, errors).fallbackMs).toBe(20 * 60_000);
      expect(errors).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
