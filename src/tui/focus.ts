/**
 * Terminal focus (DEC private mode 1004), shared by notify and the recap.
 *
 * After `CSI ? 1004 h` the terminal sends `CSI I` when the window gains focus
 * and `CSI O` when it loses it. In fullscreen mode pi-tui enables 1004 itself
 * and its viewport consumes both reports before any extension input listener
 * runs (plan section 13), so `ui.onTerminalInput` never sees them. pi-tui reads
 * the terminal with `process.stdin.on("data")`, and Node hands every chunk to
 * every "data" listener, so a listener of our own sees the raw reports in both
 * modes. In inline mode nothing enables 1004, so we do, and a terminal input
 * listener drops the reports before they reach the editor.
 *
 * stdin is one per process, so the state is a process-wide singleton (on
 * globalThis: Pi loads each `-e` extension with its own module copy).
 */

export type FocusState = "focused" | "blurred" | "unknown";

/** The slice of Pi's UI context used to keep focus reports out of the editor. */
export interface TerminalInputSource {
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
}

interface Tracker {
  state: FocusState;
  changedAt: number;
  lastInputAt: number;
  users: number;
  exitHooked?: boolean;
  /** The start of a report cut off at the end of the last chunk. */
  pending: string;
  pendingAt: number;
  onData?: (chunk: Buffer | string) => void;
  offInput?: () => void;
  focusListeners: Set<(state: FocusState) => void>;
  awayListeners: Set<(away: boolean) => void>;
}

const ENABLE = "\x1b[?1004h";
const DISABLE = "\x1b[?1004l";
const FOCUS_IN = "\x1b[I";
const FOCUS_OUT = "\x1b[O";
const KEY = Symbol.for("b4agent.focus");

function tracker(): Tracker {
  const g = globalThis as unknown as Record<symbol, Tracker | undefined>;
  return (g[KEY] ??= { state: "unknown", changedAt: 0, lastInputAt: 0, users: 0, pending: "", pendingAt: 0, focusListeners: new Set(), awayListeners: new Set() });
}

/** The last focus report in a raw input chunk ("I" in, "O" out), or undefined when it holds none. */
export function lastFocusReport(chunk: string): "I" | "O" | undefined {
  const i = chunk.lastIndexOf(FOCUS_IN);
  const o = chunk.lastIndexOf(FOCUS_OUT);
  if (i < 0 && o < 0) return undefined;
  return i > o ? "I" : "O";
}

/** Whether a raw chunk is someone at the keyboard: not only focus reports, and not bare mouse motion. */
export function isUserInput(chunk: string): boolean {
  const rest = chunk.split(FOCUS_IN).join("").split(FOCUS_OUT).join("");
  if (!rest) return false;
  // SGR mouse reports: bit 32 is motion, and low bits 3 mean no button is held.
  const moves = rest.replace(/\x1b\[<(\d+);\d+;\d+[Mm]/g, (m, b: string) => (Number(b) & 32 && (Number(b) & 3) === 3 ? "" : m));
  return moves.length > 0;
}

function setState(t: Tracker, next: FocusState, now: number) {
  if (t.state === next) return;
  const wasAway = t.state === "blurred";
  t.state = next;
  t.changedAt = now;
  for (const l of t.focusListeners) safely(() => l(next));
  if (wasAway !== (next === "blurred")) for (const l of t.awayListeners) safely(() => l(next === "blurred"));
}

function safely(f: () => void) {
  try {
    f();
  } catch {
    // a listener must not break input handling
  }
}

/** How long a chunk ending in `ESC` or `ESC [` waits for the rest of a focus report. */
const SPLIT_MS = 100;

/**
 * Feed one raw stdin chunk to the tracker. Exported for tests; the stdin
 * listener calls it. A report split across chunks (`ESC`, `[`, `O` one by
 * one, as a slow pty may deliver it) is put back together.
 */
export function handleRawInput(raw: string, now = Date.now()): void {
  const t = tracker();
  let chunk = t.pending && now - t.pendingAt <= SPLIT_MS ? t.pending + raw : raw;
  t.pending = "";
  const tail = chunk.endsWith("\x1b[") ? "\x1b[" : chunk.endsWith("\x1b") ? "\x1b" : "";
  if (tail) {
    t.pending = tail;
    t.pendingAt = now;
    chunk = chunk.slice(0, -tail.length);
  }
  const report = lastFocusReport(chunk);
  if (report) setState(t, report === "I" ? "focused" : "blurred", now);
  if (isUserInput(chunk)) {
    t.lastInputAt = now;
    // Keys only come from a focused window, even when the focus-in report got lost.
    if (t.state === "blurred" && !report) setState(t, "focused", now);
  }
}

/**
 * Start tracking (idempotent; each call returns its own stop). Enables focus
 * reporting, listens on raw stdin and, given a UI, drops the reports from the
 * editor's input. Interactive mode only.
 */
export function startFocusTracking(ui?: TerminalInputSource, write: (s: string) => void = (s) => void process.stdout.write(s)): () => void {
  const t = tracker();
  t.users++;
  if (!t.onData) {
    t.onData = (chunk) => handleRawInput(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    process.stdin.on("data", t.onData);
  }
  if (!t.exitHooked) {
    t.exitHooked = true;
    // Inline mode: leave the shell without focus reports, whatever way the process ends.
    process.once("exit", () => {
      if (tracker().onData) write(DISABLE);
    });
  }
  // Fullscreen pi-tui already enables 1004 (and turns it off at exit); writing it again is harmless.
  write(ENABLE);
  if (ui) {
    t.offInput?.();
    t.offInput = ui.onTerminalInput((data) => (data === FOCUS_IN || data === FOCUS_OUT ? { consume: true } : undefined));
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--t.users > 0) return;
    t.offInput?.();
    t.offInput = undefined;
    if (t.onData) process.stdin.off("data", t.onData);
    t.onData = undefined;
    write(DISABLE);
  };
}

/** "unknown" until the terminal reports focus once; terminals without 1004 (and tmux without `focus-events on`) stay there. */
export function focusState(): FocusState {
  return tracker().state;
}

/** The terminal window has lost focus (a `CSI O` report, no key since). */
export function isAway(): boolean {
  return tracker().state === "blurred";
}

/** When the focus state last changed (ms epoch, 0 = never). */
export function focusChangedAt(): number {
  return tracker().changedAt;
}

/** When someone last typed or clicked (ms epoch, 0 = not yet). Focus reports and bare mouse motion don't count. */
export function lastInputAt(): number {
  return tracker().lastInputAt;
}

/** Called with true when the window loses focus and false when it comes back. Returns an unsubscribe. */
export function onAwayChange(listener: (away: boolean) => void): () => void {
  const t = tracker();
  t.awayListeners.add(listener);
  return () => t.awayListeners.delete(listener);
}

/** Every focus state change. Returns an unsubscribe. */
export function onFocusChange(listener: (state: FocusState) => void): () => void {
  const t = tracker();
  t.focusListeners.add(listener);
  return () => t.focusListeners.delete(listener);
}

/** Tests only: forget all state. */
export function resetFocusForTests(): void {
  const t = tracker();
  t.state = "unknown";
  t.changedAt = 0;
  t.lastInputAt = 0;
  t.pending = "";
  t.focusListeners.clear();
  t.awayListeners.clear();
}
