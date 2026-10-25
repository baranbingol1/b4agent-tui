/**
 * Terminal title and bell for finished runs: `⚙` while the agent works, `✓`
 * when it is done (until you type again), and BEL when it finishes while you
 * are away.
 */
import type { FocusState } from "./focus.js";

export function terminalTitle(cwdName: string, sessionName?: string, mark?: string): string {
  const base = ["b4agent", sessionName, cwdName].filter(Boolean).join(" — ");
  return mark ? `${mark} ${base}` : base;
}

export interface RingQuery {
  focus: FocusState;
  /** How long the run took, and how long since the last key or click, in ms. */
  runMs: number;
  idleMs: number;
  /** `notify.minRunSeconds`, in ms. */
  minMs: number;
  aborted: boolean;
}

/**
 * Ring when the window is unfocused. When the terminal never reported focus
 * (no DEC 1004, or tmux without `focus-events on`), ring after a run of at
 * least `minMs` with no key pressed for as long: you have probably looked away.
 * Never after Esc: you were there to press it.
 */
export function shouldRing(q: RingQuery): boolean {
  if (q.aborted) return false;
  if (q.focus === "blurred") return true;
  if (q.focus === "focused") return false;
  return q.runMs >= q.minMs && q.idleMs >= q.minMs;
}
