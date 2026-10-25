import { randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Job } from "./scheduler.js";

/**
 * Durable schedules (plan section 20): `durable: true` jobs are also kept
 * in `~/.b4agent/projects/<repo>/schedules.json`, so the next session in
 * the project picks them up. There is no daemon: an overdue job fires once,
 * flagged "missed", when a session opens, and a recurring one then re-arms.
 *
 * Each entry has a holder: the session that runs it. Sessions only touch
 * their own entries. A new session adopts entries with no holder (released
 * on a clean exit) or a dead one (a crash).
 *
 * Two mechanisms keep sessions apart:
 * - The lock file (created with O_EXCL) serializes every read-modify-write,
 *   so two sessions saving at once don't lose each other's changes. It is
 *   held only inside a synchronous block, never across an await, so a lock
 *   older than a few seconds, or one whose process is gone, is stale.
 * - Adoption is a claim: an O_EXCL file `claims/<key>.<generation>`.
 *   Exactly one session can create it, so two sessions opening at once can't
 *   both take a job, and so can't both fire its missed run. This holds even
 *   if a stale-lock break went wrong; the lock only protects against lost
 *   updates.
 */

export interface Holder {
  pid: number;
  host: string;
  /** Random per session start: one process can open several sessions in turn. */
  session: string;
  /** The process's start time from /proc, to catch a reused pid. */
  start?: string;
}

export interface Entry {
  key: string;
  /** Bumped by each adoption; the claim file carries it. */
  gen: number;
  holder?: Holder;
  job: Job;
  savedAt: number;
}

interface FileShape {
  version: 1;
  entries: Entry[];
}

export const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 3_000;

/** Field 22 of /proc/<pid>/stat (start time in clock ticks), or undefined off Linux. */
export function processStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

export function selfHolder(session = randomBytes(6).toString("hex")): Holder {
  const start = processStart(process.pid);
  return { pid: process.pid, host: hostname(), session, ...(start ? { start } : {}) };
}

/** Whether the holder's session may still be running. Unknown counts as alive: never steal from a live session. */
export function holderAlive(h: Holder, self: Holder): boolean {
  if (h.host !== self.host) return true;
  // One process runs one main session at a time; an older session of this process is gone.
  if (h.pid === self.pid) return h.session === self.session;
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
  }
  if (h.start) {
    const now = processStart(h.pid);
    if (now !== undefined && now !== h.start) return false;
  }
  return true;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class DurableStore {
  readonly file: string;
  private readonly lock: string;
  private readonly claims: string;
  /** Keys this session has saved or adopted: if one vanishes from the file, someone else removed it. */
  private readonly known = new Set<string>();

  constructor(
    readonly dir: string,
    readonly self: Holder,
    private readonly opts: { now(): number; alive?(h: Holder): boolean } = { now: () => Date.now() },
  ) {
    this.file = join(dir, "schedules.json");
    this.lock = join(dir, "schedules.json.lock");
    this.claims = join(dir, "schedule-claims");
  }

  private alive(h: Holder): boolean {
    return (this.opts.alive ?? ((x) => holderAlive(x, this.self)))(h);
  }

  private mine(e: Entry): boolean {
    return !!e.holder && e.holder.session === this.self.session && e.holder.pid === this.self.pid && e.holder.host === this.self.host;
  }

  /** Entries in the file, for /loop list and tests. */
  read(): Entry[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FileShape>;
      return Array.isArray(data.entries) ? data.entries.filter((e) => e && typeof e.key === "string" && e.job && typeof e.job.prompt === "string") : [];
    } catch {
      // A torn write can't happen (rename is atomic); a hand-edited bad file is kept aside, not lost.
      try {
        renameSync(this.file, `${this.file}.bad-${Date.now()}`);
      } catch {
        // leave it
      }
      return [];
    }
  }

  private write(entries: Entry[]) {
    mkdirSync(this.dir, { recursive: true });
    if (!entries.length) {
      if (existsSync(this.file)) unlinkSync(this.file);
      try {
        rmdirSync(this.claims); // only when empty
      } catch {
        // claims of entries that are gone are removed with them; anything left stays
      }
      return;
    }
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, `${JSON.stringify({ version: 1, entries } satisfies FileShape, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  private lockStale(): boolean {
    try {
      const age = Date.now() - statSync(this.lock).mtimeMs;
      if (age > STALE_LOCK_MS) return true;
      const h = JSON.parse(readFileSync(this.lock, "utf8")) as Holder;
      return h.host === this.self.host && h.pid !== this.self.pid && !holderAlive({ ...h, session: "" }, this.self);
    } catch {
      return false; // being written or just removed: wait and look again
    }
  }

  private withLock<T>(fn: (entries: Entry[]) => { entries?: Entry[]; result: T }): T {
    mkdirSync(this.dir, { recursive: true });
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = openSync(this.lock, "wx", 0o600);
        writeSync(fd, JSON.stringify(this.self));
        closeSync(fd);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (this.lockStale()) {
          try {
            unlinkSync(this.lock);
          } catch {
            // someone else broke it first
          }
          continue;
        }
        if (Date.now() > deadline) throw new Error(`${this.lock} is held by another session`);
        sleepSync(15);
      }
    }
    try {
      const { entries, result } = fn(this.read());
      if (entries) this.write(entries);
      return result;
    } finally {
      try {
        unlinkSync(this.lock);
      } catch {
        // already gone
      }
    }
  }

  /** Creates the claim for this generation of an entry. False if another session got it first. */
  private claim(key: string, gen: number): boolean {
    mkdirSync(this.claims, { recursive: true });
    try {
      closeSync(openSync(join(this.claims, `${key}.${gen}`), "wx", 0o600));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    this.dropClaims(key, gen);
    return true;
  }

  /** Removes a key's claim files, keeping generation `keep`. */
  private dropClaims(key: string, keep?: number) {
    let names: string[] = [];
    try {
      names = readdirSync(this.claims);
    } catch {
      return;
    }
    for (const n of names) {
      if (!n.startsWith(`${key}.`) || n === `${key}.${keep}`) continue;
      try {
        unlinkSync(join(this.claims, n));
      } catch {
        // fine
      }
    }
  }

  /**
   * Adopts every entry no live session holds. Returns the jobs this session
   * now runs; an overdue one (not paused) comes back with `missed` set to
   * when it was due, so it fires once, now.
   */
  adopt(): Job[] {
    return this.withLock((entries) => {
      const now = this.opts.now();
      const taken: Job[] = [];
      for (const e of entries) {
        if (this.mine(e) || (e.holder && this.alive(e.holder))) continue;
        if (!this.claim(e.key, e.gen + 1)) continue;
        e.gen++;
        e.holder = this.self;
        e.savedAt = now;
        const missed = !e.job.paused && e.job.nextAt <= now;
        this.known.add(e.key);
        taken.push({ ...e.job, durable: e.key, ...(missed ? { missed: e.job.nextAt } : {}) });
      }
      return { entries: taken.length ? entries : undefined, result: taken };
    });
  }

  /**
   * Saves this session's durable jobs: new ones are added, changed ones
   * updated, ones that are gone (fired, cleared, stopped) removed. Returns
   * the keys another session has taken over, which this session must drop.
   */
  sync(jobs: Job[]): string[] {
    const mineNow = new Map(jobs.filter((j) => j.durable).map((j) => [j.durable!, j]));
    return this.withLock((entries) => {
      const now = this.opts.now();
      const lost: string[] = [];
      const out: Entry[] = [];
      const seen = new Set<string>();
      let changed = false;
      for (const e of entries) {
        seen.add(e.key);
        const j = mineNow.get(e.key);
        if (this.mine(e)) {
          if (!j) {
            this.dropClaims(e.key);
            this.known.delete(e.key);
            changed = true;
            continue;
          }
          out.push({ ...e, job: stored(j), savedAt: now });
          changed = true;
        } else {
          if (j) lost.push(e.key);
          out.push(e);
        }
      }
      for (const [key, j] of mineNow) {
        if (seen.has(key)) continue;
        // Gone from the file after this session saved it: another session removed it, so don't bring it back.
        if (this.known.has(key) || !this.claim(key, 1)) {
          lost.push(key);
          continue;
        }
        out.push({ key, gen: 1, holder: this.self, job: stored(j), savedAt: now });
        this.known.add(key);
        changed = true;
      }
      return { entries: changed ? out : undefined, result: lost };
    });
  }

  /** On a clean exit: keep this session's entries but let the next session adopt them. */
  release() {
    this.withLock((entries) => {
      let changed = false;
      for (const e of entries) {
        if (!this.mine(e)) continue;
        delete e.holder;
        changed = true;
      }
      return { entries: changed ? entries : undefined, result: undefined };
    });
  }
}

/** The job as saved, without the one-run "missed" flag. */
function stored(j: Job): Job {
  const { missed: _m, ...rest } = j;
  return rest;
}
