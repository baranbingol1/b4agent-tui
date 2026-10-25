import type { Job, Scheduler } from "./scheduler.js";

/**
 * The self-paced `/loop <prompt>` (plan section 20), after Claude Code's
 * dynamic /loop: each round the agent sets its own next wakeup
 * (set_schedule) or ends the loop (clear_schedule). If a round ends with
 * neither, one fallback wakeup is armed about 20 minutes out; if that round
 * doesn't reschedule either, the loop ends. An interrupted (Esc) or failed
 * round ends the loop too. Pure: the scheduler and clock come in.
 */

export const DEFAULT_FALLBACK_MS = 20 * 60_000;

export interface PacerLoop {
  prompt: string;
  startedAt: number;
  /** The current round was started by the fallback wakeup. */
  fallbackRound: boolean;
  /** The pending fallback job, if one is armed. */
  fallbackId?: string;
}

export type Settled =
  | { outcome: "idle" }
  /** The agent's own wakeup is pending; no fallback needed. */
  | { outcome: "waiting" }
  | { outcome: "armed"; job: Job }
  | { outcome: "ended"; reason: string };

export class Pacer {
  loop?: PacerLoop;

  constructor(
    private readonly s: Scheduler,
    private readonly opts: { now(): number; fallbackMs: number; target: string; fallbackPrompt(loop: PacerLoop): string },
  ) {}

  get fallbackMs(): number {
    return this.opts.fallbackMs;
  }

  start(prompt: string) {
    this.stop();
    this.loop = { prompt, startedAt: this.opts.now(), fallbackRound: false };
  }

  /** Ends the loop and drops its pending fallback. True if a loop was running. */
  stop(): boolean {
    const was = !!this.loop;
    this.cancelFallback();
    this.loop = undefined;
    return was;
  }

  /** Drops the loop without touching the scheduler: the session is closing or being replaced. */
  forget() {
    this.loop = undefined;
  }

  /** True when this job is the loop's pending fallback. */
  isFallback(id: string): boolean {
    return !!this.loop && this.loop.fallbackId === id;
  }

  /** A job fired: a round started by the fallback is the loop's last chance to reschedule. */
  fired(job: Job) {
    const l = this.loop;
    if (!l) return;
    if (job.fallback && job.id === l.fallbackId) {
      l.fallbackRound = true;
      delete l.fallbackId;
    } else if (job.target === this.opts.target && job.runMode === "existing" && !job.fallback) {
      l.fallbackRound = false;
    }
  }

  /** The agent set or changed a wakeup: a pending fallback isn't needed. */
  wakeupChanged() {
    if (this.loop && this.s.hasWakeup(this.opts.target)) this.cancelFallback();
  }

  /** The target's run settled. Decides whether the loop waits, arms its fallback, or ends. */
  settled(run: { aborted?: boolean; failed?: string }): Settled {
    const l = this.loop;
    if (!l) return { outcome: "idle" };
    if (run.aborted) return this.end("the round was interrupted");
    if (run.failed) return this.end(`the round failed: ${run.failed}`);
    if (this.s.hasWakeup(this.opts.target)) {
      this.cancelFallback();
      l.fallbackRound = false;
      return { outcome: "waiting" };
    }
    if (l.fallbackRound) return this.end("the fallback round didn't schedule another");
    if (this.opts.fallbackMs <= 0) return this.end("the round didn't schedule another");
    this.cancelFallback();
    const job = this.s.add({
      owner: "user",
      target: this.opts.target,
      prompt: this.opts.fallbackPrompt(l),
      nextAt: this.opts.now() + this.opts.fallbackMs,
      runMode: "existing",
      loop: true,
      fallback: true,
    });
    if (typeof job === "string") return this.end(job);
    l.fallbackId = job.id;
    return { outcome: "armed", job };
  }

  private end(reason: string): Settled {
    this.stop();
    return { outcome: "ended", reason };
  }

  private cancelFallback() {
    const id = this.loop?.fallbackId;
    if (!id) return;
    delete this.loop!.fallbackId;
    this.s.remove(id);
  }
}
