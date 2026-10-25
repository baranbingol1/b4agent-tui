import { type Conversation, isPresence, recapBlocker, type RecapSettings, type SavedRecap } from "./trigger.js";
import type { Generated } from "./generate.js";

/**
 * The away-mode state machine (plan section 3):
 *
 *   agent settles (not aborted)
 *     -> no keystrokes for `awayMs` (counted from the later of the last key and the settle)
 *     -> conditions hold: generate in the background, so it is ready on return
 *     -> finished, and the conversation leaf is unchanged: save it and show it
 *     -> typing or sending hides it
 *
 * Any keystroke or `agent_start` cancels a recap in flight. On a resume or
 * fork the saved recap is shown if it still matches the leaf; otherwise one
 * is generated right away. Everything outside (clock, timers, session, UI,
 * the model call) comes through `RecapHost`, so tests drive it directly.
 */
export interface RecapHost {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  conversation(): Conversation;
  draft(): string;
  /** Agent not streaming, nothing queued, no dialog waiting on the user. */
  idle(): boolean;
  generate(conversation: Conversation, signal: AbortSignal): Promise<Generated>;
  show(recap: SavedRecap | undefined): void;
  status(text: string | undefined): void;
  save(recap: SavedRecap): void;
  log?(message: string): void;
}

/** A recap being written: its abort, the leaf it describes, and whether a cancel should retry on the next away. */
type Job = { abort: AbortController; leafId: string | null; rearm?: boolean };

export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

export class RecapController {
  private lastActivity: number;
  /** A run settled cleanly since the last recap attempt, so going away should produce one. */
  private armed = false;
  private timer: unknown;
  private job: Job | undefined;
  private shown: SavedRecap | undefined;
  private disposed = false;

  constructor(
    private readonly host: RecapHost,
    private readonly settings: Pick<RecapSettings, "awayMs" | "minTurns">,
  ) {
    this.lastActivity = host.now();
  }

  get generating(): boolean {
    return this.job !== undefined;
  }

  get visible(): SavedRecap | undefined {
    return this.shown;
  }

  /** `agent_settled`. */
  settled(aborted: boolean): void {
    this.lastActivity = this.host.now();
    this.armed = !aborted;
    this.schedule();
  }

  /** Raw terminal input. */
  input(data: string): void {
    if (!isPresence(data)) return;
    this.lastActivity = this.host.now();
    this.cancel("input");
    // The key reaches the editor after the listeners run; hide once it has put text there.
    if (this.shown) this.host.setTimer(() => this.host.draft().trim() && this.hide(), 0);
    this.schedule();
  }

  /** The user sent a prompt (Pi's `input` event). */
  sent(): void {
    this.hide();
  }

  /** `agent_start`. */
  agentStart(): void {
    this.cancel("agent_start");
    this.hide();
    this.armed = false;
    this.clearTimer();
  }

  /** The conversation was rewritten under us (`/tree`): what is shown no longer describes it. */
  moved(): void {
    this.cancel("tree");
    this.hide();
  }

  /** `session_start`. Coming back to an existing session counts as returning from away. */
  sessionStart(reason: StartReason): void {
    this.cancel("session_start");
    this.hide();
    this.lastActivity = this.host.now();
    if (reason !== "resume" && reason !== "fork" && reason !== "startup") return;
    const c = this.host.conversation();
    const saved = c.lastRecap;
    if (saved && saved.leafId === c.leafId && c.turnsSinceRecap === 0) {
      this.display(saved);
      return;
    }
    void this.start(c);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel("dispose");
    this.clearTimer();
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = undefined;
    this.host.show(undefined);
  }

  private display(r: SavedRecap): void {
    this.shown = r;
    this.host.show(r);
  }

  private cancel(why: string): void {
    if (!this.job) return;
    this.host.log?.(`recap cancelled (${why})`);
    // Only a keystroke means "back before it was ready, try again when they leave"; a new run or session starts over.
    this.job.rearm = why === "input";
    this.job.abort.abort();
    this.job = undefined;
    this.host.status(undefined);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.host.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    this.clearTimer();
    if (!this.armed || this.job || this.disposed) return;
    const wait = Math.max(0, this.lastActivity + this.settings.awayMs - this.host.now());
    this.timer = this.host.setTimer(() => this.tick(), wait);
  }

  /** The away timer fired. */
  tick(): void {
    this.timer = undefined;
    if (!this.armed || this.job || this.disposed) return;
    if (this.host.now() - this.lastActivity < this.settings.awayMs) return this.schedule();
    // One attempt per settled run: a failure or a skip waits for the next turn; a keystroke cancel re-arms.
    this.armed = false;
    void this.start(this.host.conversation());
  }

  private async start(c: Conversation): Promise<void> {
    const why = recapBlocker({ conversation: c, draft: this.host.draft(), idle: this.host.idle() }, this.settings);
    if (why) {
      this.host.log?.(`recap skipped: ${why}`);
      return;
    }
    const job: Job = { abort: new AbortController(), leafId: c.leafId };
    this.job = job;
    this.host.status("recap…");
    let result: Generated | undefined;
    let error: unknown;
    try {
      result = await this.host.generate(c, job.abort.signal);
    } catch (e) {
      error = e;
    }
    if (this.job !== job) {
      if (!this.disposed && job.rearm) {
        this.armed = true;
        this.schedule();
      }
      return;
    }
    this.job = undefined;
    this.host.status(undefined);
    if (!result) {
      this.host.log?.(`recap failed: ${(error as Error)?.message ?? String(error)}`);
      return;
    }
    const now = this.host.conversation();
    if (now.leafId !== job.leafId) {
      this.host.log?.("recap dropped: the conversation moved on while it was written");
      return;
    }
    if (this.host.draft().trim() || !this.host.idle()) {
      this.host.log?.("recap dropped: the user is typing or the agent is running");
      return;
    }
    const saved: SavedRecap = { ...result, leafId: job.leafId };
    this.host.save(saved);
    this.display(saved);
  }
}
