import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DurableStore, type Holder, holderAlive } from "../../src/schedule/durable.js";
import { type Job, Scheduler } from "../../src/schedule/scheduler.js";

let dir: string;
let now: number;
/** Sessions still running; the rest count as closed or crashed. */
let live: Set<string>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b4-durable-"));
  now = 1_000_000;
  live = new Set();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One session: its store and its scheduler, wired like the extension. */
function session(name: string) {
  const holder: Holder = { pid: process.pid, host: "h", session: name };
  live.add(name);
  const store = new DurableStore(dir, holder, { now: () => now, alive: (h) => live.has(h.session) });
  const fired: Job[] = [];
  const s = new Scheduler({ now: () => now, busy: () => false, fire: async (j) => void fired.push(j), changed: (jobs) => store.sync(jobs) });
  const open = () => store.adopt().map((j) => s.adopt(j));
  const close = () => {
    store.release();
    live.delete(name);
  };
  return { store, s, fired, open, close, crash: () => live.delete(name) };
}

const job = (over: Partial<Job> = {}): Omit<Job, "id" | "runs" | "createdAt"> => ({ owner: "main", target: "main", prompt: "check CI", nextAt: now + 60_000, runMode: "existing", durable: "k1", ...over });
const saved = () => (existsSync(join(dir, "schedules.json")) ? (JSON.parse(readFileSync(join(dir, "schedules.json"), "utf8")) as { entries: { key: string; holder?: Holder; job: Job }[] }).entries : []);

describe("durable schedules", () => {
  it("fires a missed one-shot once in the next session, flagged missed, then drops it from the file", async () => {
    const a = session("A");
    a.s.add(job());
    expect(saved()).toHaveLength(1);
    a.close();
    expect(saved()[0]!.holder).toBeUndefined();

    now += 10 * 60_000; // it was due while no session was open
    const b = session("B");
    const [j] = b.open();
    expect(j!.missed).toBe(1_060_000);
    await b.s.tick();
    await b.s.tick();
    expect(b.fired).toHaveLength(1);
    expect(b.fired[0]!.missed).toBe(1_060_000);
    expect(saved()).toEqual([]);
  });

  it("re-arms a missed recurring job from the time it fires, and saves it without the missed flag", async () => {
    const a = session("A");
    a.s.add(job({ rule: { freq: "HOURLY", interval: 1 } }));
    a.close();
    now += 5 * 3_600_000; // five runs were due; one catch-up fires
    const b = session("B");
    b.open();
    await b.s.tick();
    await b.s.tick();
    expect(b.fired).toHaveLength(1);
    const [entry] = saved();
    expect(entry!.job.nextAt).toBe(now + 3_600_000);
    expect(entry!.job.missed).toBeUndefined();
    expect(entry!.holder?.session).toBe("B");
    b.close();
    // Opened again before the next run is due: adopted, but nothing is missed.
    now += 60_000;
    const c = session("C");
    const [again] = c.open();
    expect(again!.missed).toBeUndefined();
    await c.s.tick();
    expect(c.fired).toEqual([]);
  });

  it("leaves a live session's jobs alone, and adopts a crashed one's", () => {
    const a = session("A");
    a.s.add(job({ nextAt: now - 1 }));
    const b = session("B");
    expect(b.open()).toEqual([]);
    a.crash();
    expect(b.open()).toHaveLength(1);
    expect(saved()[0]!.holder?.session).toBe("B");
  });

  it("lets only one of two sessions opening at once take a missed run, even when their writes race", async () => {
    const a = session("A");
    a.s.add(job({ nextAt: now - 1 }));
    a.close();
    const before = readFileSync(join(dir, "schedules.json"), "utf8");
    const b = session("B");
    const c = session("C");
    expect(b.open()).toHaveLength(1);
    // C saw the file before B's write landed (a lost update): the claim file still stops it.
    writeFileSync(join(dir, "schedules.json"), before);
    expect(c.open()).toEqual([]);
    await b.s.tick();
    await c.s.tick();
    expect(b.fired.length + c.fired.length).toBe(1);
  });

  it("removes a cleared or replaced durable job from the file, and keeps non-durable ones out of it", () => {
    const a = session("A");
    const j = a.s.add(job()) as Job;
    a.s.add({ ...job({ durable: undefined, target: "w" }) });
    expect(saved().map((e) => e.key)).toEqual(["k1"]);
    a.s.remove(j.id);
    expect(saved()).toEqual([]);
    a.s.add(job({ durable: "k2" }));
    a.s.add(job({ durable: undefined, prompt: "replaced, not durable" })); // one schedule per target: replaces k2
    expect(saved()).toEqual([]);
  });

  it("doesn't bring back a job another session removed", () => {
    const a = session("A");
    a.s.add(job());
    a.crash();
    const b = session("B");
    const [taken] = b.open();
    b.s.remove(taken!.id);
    live.add("A"); // A was only stalled, not dead, and saves again
    expect(a.store.sync([...a.s.jobs.values()])).toEqual(["k1"]);
    expect(saved()).toEqual([]);
  });

  it("breaks a lock left by a dead process", () => {
    const a = session("A");
    writeFileSync(join(dir, "schedules.json.lock"), JSON.stringify({ pid: 2 ** 30, host: a.store.self.host, session: "x" }));
    a.s.add(job());
    expect(saved()).toHaveLength(1);
    expect(existsSync(join(dir, "schedules.json.lock"))).toBe(false);
  });

  it("treats an older session of this same process as gone", () => {
    const self: Holder = { pid: process.pid, host: "h", session: "now" };
    expect(holderAlive({ ...self, session: "before" }, self)).toBe(false);
    expect(holderAlive(self, self)).toBe(true);
    expect(holderAlive({ ...self, host: "elsewhere", pid: 2 ** 30 }, self)).toBe(true);
    expect(holderAlive({ ...self, pid: 2 ** 30 }, self)).toBe(false);
  });
});
