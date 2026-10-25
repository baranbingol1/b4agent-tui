import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BashOperations, createBashToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { BashJob, Hub } from "../agents/hub.js";

/**
 * Pi's bash, plus background jobs (plan section 2):
 * - `background: true` starts the command as a job and returns at once;
 * - a command still running after `autoBackgroundSeconds` (default 60) is
 *   moved to the background, unless the call set its own timeout;
 * - Ctrl+B moves the running commands to the background right away.
 * Every job is a process group, killed with SIGTERM then SIGKILL after 3 s,
 * and its output goes to a log file. When it ends, whoever started it gets
 * a message with the exit code and the last lines.
 */

const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "bash";
const TAIL_LINES = 40;
const MEMORY_CAP = 1024 * 1024;

export interface BashOptions {
  hub: () => Hub | undefined;
  /** Agent name that owns jobs started here. */
  owner: string;
  autoBackgroundSeconds: number;
  logDir: (ctx: ExtensionContext) => string;
}

/** Foreground commands that can be sent to the background (Ctrl+B). */
const foreground = new Set<{ owner: string; background: () => void }>();

export function backgroundForeground(owner?: string): number {
  let n = 0;
  for (const f of [...foreground]) {
    if (owner && f.owner !== owner) continue;
    f.background();
    n++;
  }
  return n;
}

export function hasForeground(owner?: string): boolean {
  return [...foreground].some((f) => !owner || f.owner === owner);
}

function killGroup(child: ChildProcess) {
  const pid = child.pid;
  if (!pid) return;
  const send = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        // already gone
      }
    }
  };
  send("SIGTERM");
  const t = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) send("SIGKILL");
  }, 3000);
  t.unref();
}

function tail(text: string): string {
  return text.split("\n").slice(-TAIL_LINES).join("\n").trim();
}

function spawnGroup(command: string, cwd: string, env?: NodeJS.ProcessEnv): ChildProcess {
  return spawn(SHELL, ["-c", command], { cwd, env: env ?? process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}

export function registerBash(pi: ExtensionAPI, opts: BashOptions) {
  const base = createBashToolDefinition(process.cwd());
  const baseProps = (base.parameters as unknown as { properties: Record<string, never> }).properties;

  /** Turns a running child into a hub job. Output from here on goes to the log only. */
  function adopt(child: ChildProcess, command: string, cwd: string, ctx: ExtensionContext, earlier: string): BashJob | undefined {
    const hub = opts.hub();
    if (!hub) return undefined;
    const dir = opts.logDir(ctx);
    mkdirSync(dir, { recursive: true });
    const job = hub.addJob({
      owner: opts.owner,
      command,
      cwd,
      status: "running",
      log: "",
      startedAt: Date.now(),
      kill: () => killGroup(child),
    });
    job.log = join(dir, `${job.id}.log`);
    writeFileSync(job.log, earlier);
    let recent = earlier.slice(-MEMORY_CAP);
    const onData = (d: Buffer) => {
      const s = d.toString("utf8");
      recent = (recent + s).slice(-MEMORY_CAP);
      try {
        appendFileSync(job.log, s);
      } catch {
        // log dir removed
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const original = job.kill;
    let killed = false;
    job.kill = () => {
      killed = true;
      original();
    };
    child.on("close", (code) => hub.finishJob(job, killed ? null : code, tail(recent), killed));
    return job;
  }

  pi.registerTool({
    name: "bash",
    label: "bash",
    description: `${base.description} Set background: true for servers, watchers and long builds: the command keeps running as a job and you get a message when it ends. A command still running after ${opts.autoBackgroundSeconds}s is moved to the background automatically unless you set a timeout.`,
    promptSnippet: base.promptSnippet ?? "Execute bash commands (ls, grep, find, etc.)",
    ...(base.promptGuidelines ? { promptGuidelines: base.promptGuidelines } : {}),
    parameters: Type.Object({
      ...baseProps,
      background: Type.Optional(Type.Boolean({ description: "Run as a background job and return immediately." })),
    }),
    async execute(id, params, signal, onUpdate, ctx) {
      const { command, timeout, background } = params as { command: string; timeout?: number; background?: boolean };
      if (background) {
        const child = spawnGroup(command, ctx.cwd);
        const job = adopt(child, command, ctx.cwd, ctx, "");
        if (!job) {
          killGroup(child);
          throw new Error("background jobs are not available in this session");
        }
        return {
          content: [{ type: "text", text: `Started background job ${job.id} (pid ${child.pid}). Output goes to ${job.log}. You'll get a message when it ends; stop it with agents { action: "stop", name: "${job.id}" }.` }],
          details: { job: job.id, log: job.log },
        };
      }

      const operations: BashOperations = {
        exec: (cmd, cwd, { onData, signal: execSignal, timeout: t, env }) =>
          new Promise((done, fail) => {
            if (execSignal?.aborted) return fail(new Error("aborted"));
            const child = spawnGroup(cmd, cwd, env);
            let buffered = "";
            let moved = false;
            const forward = (d: Buffer) => {
              if (moved) return;
              buffered = (buffered + d.toString("utf8")).slice(-MEMORY_CAP);
              onData(d);
            };
            child.stdout?.on("data", forward);
            child.stderr?.on("data", forward);
            let timedOut = false;
            const timeoutHandle = t ? setTimeout(() => ((timedOut = true), killGroup(child)), t * 1000) : undefined;
            const onAbort = () => killGroup(child);
            execSignal?.addEventListener("abort", onAbort, { once: true });
            const entry = {
              owner: opts.owner,
              background: () => {
                if (moved) return;
                const job = adopt(child, command, cwd, ctx, buffered);
                if (!job) return;
                moved = true;
                cleanup();
                onData(Buffer.from(`\n[b4agent] Moved to the background as job ${job.id}; it keeps running. Output continues in ${job.log}. You'll get a message when it ends; stop it with agents { action: "stop", name: "${job.id}" }.\n`));
                done({ exitCode: 0 });
              },
            };
            // An explicit timeout means the caller wants to wait for the result.
            const autoTimer = !t && opts.autoBackgroundSeconds > 0 ? setTimeout(entry.background, opts.autoBackgroundSeconds * 1000) : undefined;
            foreground.add(entry);
            const cleanup = () => {
              foreground.delete(entry);
              if (autoTimer) clearTimeout(autoTimer);
              if (timeoutHandle) clearTimeout(timeoutHandle);
              execSignal?.removeEventListener("abort", onAbort);
            };
            child.on("error", (e) => {
              if (moved) return;
              cleanup();
              fail(e);
            });
            child.on("close", (code, sig) => {
              if (moved) return;
              cleanup();
              if (execSignal?.aborted) return fail(new Error("aborted"));
              if (timedOut) return fail(new Error(`timeout:${t}`));
              done({ exitCode: code ?? (sig ? 128 + 15 : null) });
            });
          }),
      };
      const def = createBashToolDefinition(ctx.cwd, { operations });
      return def.execute(id, { command, ...(timeout !== undefined ? { timeout } : {}) }, signal, onUpdate, ctx);
    },
  });
}
