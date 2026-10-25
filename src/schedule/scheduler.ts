/**
 * Schedules (plan section 20): /loop and Amp-shaped set_schedule. Pure and
 * clock-injected; the extension supplies firing and the "is it busy" check.
 *
 * A due job whose target is busy waits and fires once when it's free, so
 * fires missed during a long turn collapse into one catch-up. The next run
 * is always computed from the time of the fire, never queued up.
 *
 * Durable jobs are saved for later sessions by durable.ts; the self-paced
 * /loop and its fallback wakeup are pacer.ts.
 */

export type Freq = "MINUTELY" | "HOURLY" | "DAILY" | "WEEKLY";
export interface Rule {
  freq: Freq;
  interval: number;
  /** Total runs, then the job ends. */
  count?: number;
}

export interface Job {
  id: string;
  /** Who set it up: "user" for /loop, else an agent name. */
  owner: string;
  /** The agent it wakes. */
  target: string;
  prompt: string;
  rule?: Rule;
  /** One-shot jobs: fire at this time. Recurring jobs: the next fire. */
  nextAt: number;
  runs: number;
  runMode: "existing" | "fresh";
  /** Set by /loop; agents keep one schedule per target. */
  loop?: boolean;
  paused?: string;
  createdAt: number;
  /** Durable jobs: the key in the project's schedules.json (see durable.ts). */
  durable?: string;
  /** Set when a durable job is picked up overdue by a new session: when the run was due. Cleared once it fires. */
  missed?: number;
  /** The fallback wakeup of a self-paced /loop (see pacer.ts). */
  fallback?: boolean;
}

const MS: Record<Freq, number> = { MINUTELY: 60_000, HOURLY: 3_600_000, DAILY: 86_400_000, WEEKLY: 604_800_000 };
export const MAX_JOBS = 50;
export const MIN_INTERVAL_MS = 60_000;
export const MIN_DELAY_MS = 5_000;

export function ruleMs(r: Rule): number {
  return MS[r.freq] * r.interval;
}

/** RRULE subset: FREQ (MINUTELY, HOURLY, DAILY, WEEKLY), INTERVAL, COUNT. Anything else is an error, not ignored. */
export function parseRRule(text: string): Rule | string {
  const parts = text.trim().replace(/^RRULE:/i, "").split(";").filter(Boolean);
  let freq: Freq | undefined;
  let interval = 1;
  let count: number | undefined;
  for (const p of parts) {
    const [k, v] = p.split("=") as [string, string | undefined];
    const key = k.trim().toUpperCase();
    const val = (v ?? "").trim().toUpperCase();
    if (key === "FREQ") {
      if (!(val in MS)) return `FREQ=${val} is not supported; use MINUTELY, HOURLY, DAILY or WEEKLY`;
      freq = val as Freq;
    } else if (key === "INTERVAL") {
      interval = Number(val);
      if (!Number.isInteger(interval) || interval < 1) return "INTERVAL must be a positive whole number";
    } else if (key === "COUNT") {
      count = Number(val);
      if (!Number.isInteger(count) || count < 1) return "COUNT must be a positive whole number";
    } else {
      return `${key} is not supported; only FREQ, INTERVAL and COUNT are`;
    }
  }
  if (!freq) return "FREQ is required";
  const rule: Rule = { freq, interval, ...(count ? { count } : {}) };
  if (ruleMs(rule) < MIN_INTERVAL_MS) return "the shortest interval is one minute";
  return rule;
}

/** "30s", "5m", "2h", "1d", "every 10 minutes". Returns milliseconds. */
export function parseInterval(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/^every\s+/, "");
  const m = /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)$/.exec(t) ?? /^(\d+)(s|m|h|d)$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const u = m[2]![0]!;
  return n * (u === "s" ? 1000 : u === "m" ? 60_000 : u === "h" ? 3_600_000 : 86_400_000);
}

/** An interval in ms as the closest rule (minutes, hours or days). */
export function intervalRule(ms: number): Rule {
  if (ms % 86_400_000 === 0) return { freq: "DAILY", interval: ms / 86_400_000 };
  if (ms % 3_600_000 === 0) return { freq: "HOURLY", interval: ms / 3_600_000 };
  return { freq: "MINUTELY", interval: Math.max(1, Math.round(ms / 60_000)) };
}

export function describeRule(r: Rule | undefined): string {
  if (!r) return "once";
  const unit = { MINUTELY: "minute", HOURLY: "hour", DAILY: "day", WEEKLY: "week" }[r.freq];
  const every = r.interval === 1 ? `every ${unit}` : `every ${r.interval} ${unit}s`;
  return r.count ? `${every}, ${r.count} times` : every;
}

export interface SchedulerHooks {
  now(): number;
  /** True while the target can't take a new turn. */
  busy(target: string): boolean;
  /** Fires one run; a rejection pauses the job. */
  fire(job: Job): Promise<void>;
  /** Called after any change, to persist. */
  changed(jobs: Job[]): void;
}

export class Scheduler {
  readonly jobs = new Map<string, Job>();
  private counter = 0;
  private firing = new Set<string>();

  constructor(private readonly hooks: SchedulerHooks) {}

  load(jobs: Job[]) {
    this.jobs.clear();
    for (const j of jobs) {
      this.jobs.set(j.id, { ...j });
      const n = Number(/^s(\d+)$/.exec(j.id)?.[1]);
      if (n > this.counter) this.counter = n;
    }
  }

  add(job: Omit<Job, "id" | "runs" | "createdAt">): Job | string {
    // Agents keep one schedule per target (Amp's one per thread); setting again replaces it.
    const same = job.loop ? undefined : [...this.jobs.values()].find((j) => !j.loop && j.target === job.target);
    if (!same && this.jobs.size >= MAX_JOBS) return `There are already ${MAX_JOBS} schedules in this session; clear one first.`;
    if (same) this.jobs.delete(same.id);
    const j: Job = { ...job, id: same?.id ?? `s${++this.counter}`, runs: 0, createdAt: this.hooks.now() };
    this.jobs.set(j.id, j);
    this.hooks.changed([...this.jobs.values()]);
    return j;
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    if (ok) this.hooks.changed([...this.jobs.values()]);
    return ok;
  }

  /** A key given as undefined is removed from the job. */
  update(id: string, patch: Partial<Pick<Job, "prompt" | "rule" | "nextAt" | "paused" | "runMode" | "durable">>) {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (j as unknown as Record<string, unknown>)[k];
    this.hooks.changed([...this.jobs.values()]);
  }

  /**
   * Takes in a job saved by another session (a durable one), under a new
   * local id. It stays the target's agent schedule unless the target
   * already has one here; then it becomes a separate job, like a loop.
   */
  adopt(saved: Job): Job {
    const clash = !saved.loop && this.agentSchedule(saved.target);
    const j: Job = { ...saved, id: `s${++this.counter}`, ...(clash ? { loop: true } : {}) };
    this.jobs.set(j.id, j);
    this.hooks.changed([...this.jobs.values()]);
    return j;
  }

  agentSchedule(target: string): Job | undefined {
    return [...this.jobs.values()].find((j) => !j.loop && j.target === target);
  }

  /** True when a schedule will wake the target itself later: an active agent schedule, not a /loop or a fallback. */
  hasWakeup(target: string): boolean {
    return [...this.jobs.values()].some((j) => !j.loop && !j.fallback && !j.paused && j.target === target && j.runMode === "existing");
  }

  /** Fires every due job whose target is free. Call once a second. */
  async tick(): Promise<void> {
    const now = this.hooks.now();
    for (const j of [...this.jobs.values()]) {
      if (j.paused || j.nextAt > now || this.firing.has(j.id)) continue;
      if (j.runMode === "existing" && this.hooks.busy(j.target)) continue;
      this.firing.add(j.id);
      j.runs++;
      const last = j.rule?.count !== undefined && j.runs >= j.rule.count;
      if (!j.rule || last) this.jobs.delete(j.id);
      else j.nextAt = now + ruleMs(j.rule);
      // The fire sees this run as it was (with its "missed" flag); the job goes on without it.
      const run = { ...j };
      delete j.missed;
      this.hooks.changed([...this.jobs.values()]);
      try {
        await this.hooks.fire(run);
      } catch (e) {
        this.pause(j, (e as Error).message);
      } finally {
        this.firing.delete(j.id);
      }
    }
  }

  /** A failed run pauses its schedule (Amp); the caller tells the owner. */
  pause(j: Job, reason: string) {
    if (!this.jobs.has(j.id)) return;
    j.paused = reason;
    this.hooks.changed([...this.jobs.values()]);
  }
}
