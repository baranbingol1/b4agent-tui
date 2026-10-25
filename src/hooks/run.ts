import { spawn } from "node:child_process";
import type { CommandHook } from "./config.js";

/** Default per-hook timeout in seconds (Droid's; Claude Code and Codex use 600). */
export const DEFAULT_TIMEOUT_S = 60;
/** Claude Code gives SessionEnd hooks 1.5 s unless the hook sets its own timeout (capped at 60 s). */
export const SESSION_END_TIMEOUT_S = 1.5;
const MAX_OUTPUT = 1024 * 1024;
/** After the hook exits, how long to keep reading output a background child may still hold open. */
const DRAIN_MS = 100;

export interface HookRun {
  hook: CommandHook;
  /** null when it never exited on its own (timeout, abort, spawn error). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
  ms: number;
}

export interface RunOptions {
  cwd: string;
  /** CLAUDE_PROJECT_DIR and its B4AGENT_PROJECT_DIR alias. */
  projectDir: string;
  timeoutS?: number;
  signal?: AbortSignal;
}

/** Placeholders Claude Code substitutes into exec-form `command` and `args`. */
function substitute(s: string, projectDir: string): string {
  return s.replace(/\$\{(CLAUDE_PROJECT_DIR|B4AGENT_PROJECT_DIR)\}/g, projectDir);
}

/**
 * Runs one command hook: the event's JSON on stdin, `sh -c` for the shell
 * form, a direct spawn for the exec form (`args`). The hook gets its own
 * process group and no terminal; on timeout or abort the whole group is killed.
 */
export function runHook(hook: CommandHook, input: unknown, opts: RunOptions): Promise<HookRun> {
  const started = Date.now();
  const timeoutS = hook.timeout ?? opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const env = { ...process.env, CLAUDE_PROJECT_DIR: opts.projectDir, B4AGENT_PROJECT_DIR: opts.projectDir };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let exitCode: number | null = null;
    let drain: NodeJS.Timeout | undefined;
    const finish = (extra: Partial<HookRun> = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ hook, exitCode, stdout, stderr, timedOut, ms: Date.now() - started, ...extra });
    };
    let child;
    try {
      child = hook.args
        ? spawn(substitute(hook.command, opts.projectDir), hook.args.map((a) => substitute(a, opts.projectDir)), { cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
        : spawn("/bin/sh", ["-c", hook.command], { cwd: opts.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      resolve({ hook, exitCode: null, stdout, stderr, timedOut, spawnError: (e as Error).message, ms: 0 });
      return;
    }
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish();
    }, timeoutS * 1000);
    const onAbort = () => {
      kill();
      finish({ spawnError: "cancelled" });
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString("utf8");
    });
    child.on("error", (e) => finish({ spawnError: e.message }));
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? 128 : null);
      // A process the hook left in the background may hold stdout open; don't wait for it.
      drain = setTimeout(() => finish(), DRAIN_MS);
    });
    child.on("close", () => finish());
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify(input));
  });
}

// ---------------------------------------------------------------------------
// Reading the result, after Claude Code's exit-code table.

export type Parsed =
  | { kind: "json"; value: Record<string, unknown> }
  | { kind: "text"; text: string }
  | { kind: "invalid"; error: string };

/** stdout is JSON only when it is one object with nothing around it but whitespace. */
export function parseStdout(stdout: string): Parsed {
  const t = stdout.trim();
  if (!t.startsWith("{") || !t.endsWith("}")) return { kind: "text", text: t };
  try {
    const v = JSON.parse(t) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return { kind: "json", value: v as Record<string, unknown> };
    return { kind: "invalid", error: "not a JSON object" };
  } catch (e) {
    return { kind: "invalid", error: (e as Error).message };
  }
}

export interface Outcome {
  hook: CommandHook;
  /** Exit code 2, or a failure of an `onFailure: "block"` hook. */
  blocking: boolean;
  /** Why it blocked: stderr for exit 2. */
  blockReason?: string;
  /** JSON fields, when stdout was a JSON object and the exit code lets them apply. */
  json?: Record<string, unknown>;
  /** Plain-text stdout of a successful run. */
  text?: string;
  /** A non-blocking error to show the user. */
  error?: string;
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";

/**
 * - exit 0: JSON fields apply; plain text is kept (some events add it as context).
 * - exit 2: blocks; the reason is stderr; JSON fields are still read but can't undo the block.
 * - another code: JSON that parses still decides; otherwise a non-blocking error.
 * - timeout, spawn failure, bad JSON: a non-blocking error, or a block with `onFailure: "block"`.
 */
export function outcomeOf(run: HookRun): Outcome {
  const { hook } = run;
  const failBlocks = hook.onFailure === "block";
  const failure = (error: string): Outcome => (failBlocks ? { hook, blocking: true, blockReason: `${error}; blocking because onFailure is "block"`, error } : { hook, blocking: false, error });
  if (run.spawnError === "cancelled") return { hook, blocking: false };
  if (run.spawnError) return failure(`failed to start: ${run.spawnError}`);
  if (run.timedOut) return failure(`timed out after ${hook.timeout ?? DEFAULT_TIMEOUT_S}s`);
  const parsed = parseStdout(run.stdout);
  if (run.exitCode === 2) {
    return { hook, blocking: true, blockReason: run.stderr.trim() || "(the hook gave no reason)", ...(parsed.kind === "json" ? { json: parsed.value } : {}) };
  }
  if (run.exitCode === 0) {
    if (parsed.kind === "json") return { hook, blocking: false, json: parsed.value };
    if (parsed.kind === "invalid") return failure(`invalid JSON output: ${parsed.error}`);
    return { hook, blocking: false, ...(parsed.text ? { text: parsed.text } : {}) };
  }
  if (parsed.kind === "json" && !failBlocks) return { hook, blocking: false, json: parsed.value };
  return failure(`failed with non-blocking status code ${run.exitCode}${firstLine(run.stderr) ? `: ${firstLine(run.stderr)}` : ""}`);
}

/** Runs hooks in parallel (Claude Code and Codex both do). */
export async function runAll(hooks: readonly CommandHook[], input: unknown, opts: RunOptions): Promise<Outcome[]> {
  const runs = await Promise.all(hooks.map((h) => runHook(h, input, opts)));
  return runs.map(outcomeOf);
}
