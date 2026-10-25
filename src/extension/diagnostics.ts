import { existsSync } from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadTuiSettings } from "../tui/settings.js";

/**
 * Checker diagnostics after edits: at the end of a run that edited files, the
 * project's own checker runs once (tsc, ruff, go vet or cargo check, picked
 * from project markers and the touched files, or `diagnostics.command`), and
 * failures on the touched files are queued for the agent's next turn. Nothing
 * runs mid-run, and a clean check says nothing.
 */

const TIMEOUT_MS = 60_000;
const MAX_CHARS = 2500;
const STATUS = "b4agent.diagnostics";

export interface Checker {
  label: string;
  command: string;
  args: string[];
}

/** The configured command wins; otherwise a checker for the touched files' language from the project markers in cwd. */
export function detectChecker(cwd: string, touched: readonly string[], override?: string): Checker | undefined {
  if (override) {
    const [command, ...args] = override.split(/\s+/).filter(Boolean);
    return command ? { label: override, command, args } : undefined;
  }
  const has = (f: string) => existsSync(path.join(cwd, f));
  const ext = (...e: string[]) => touched.some((f) => e.some((x) => f.endsWith(x)));
  if (has("tsconfig.json") && ext(".ts", ".tsx", ".mts", ".cts")) {
    // Only the project's own TypeScript: a bare `npx tsc` can fetch the unrelated "tsc" package.
    const tsc = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    return existsSync(tsc) ? { label: "tsc --noEmit", command: tsc, args: ["--noEmit", "--pretty", "false"] } : undefined;
  }
  if ((has("pyproject.toml") || has("setup.py") || has("ruff.toml")) && ext(".py")) return { label: "ruff check", command: "ruff", args: ["check", "--output-format", "concise", "."] };
  if (has("go.mod") && ext(".go")) return { label: "go vet", command: "go", args: ["vet", "./..."] };
  if (has("Cargo.toml") && ext(".rs")) return { label: "cargo check", command: "cargo", args: ["check", "--quiet", "--message-format", "short"] };
  return undefined;
}

/**
 * The output lines that name a touched file, capped. With `head`, output that
 * names none of them gives its first 15 lines instead (a configured command
 * may print paths another way); otherwise it gives nothing, since errors in
 * files the agent didn't touch may be someone else's work in progress.
 */
export function filterToTouched(output: string, touched: readonly string[], cwd: string, head = false): string {
  const rels = touched.map((f) => path.relative(cwd, path.resolve(cwd, f)).replace(/\\/g, "/").toLowerCase());
  const lines = output.split(/\r?\n/).filter((l) => l.trim());
  const hits = lines.filter((l) => {
    const n = l.replace(/\\/g, "/").toLowerCase();
    return rels.some((r) => n.includes(r));
  });
  const chosen = hits.length ? hits : head ? lines.slice(0, 15) : [];
  const text = chosen.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n… (${chosen.length} lines in all, cut)` : text;
}

export default function diagnostics(pi: ExtensionAPI) {
  const touched = new Set<string>();
  let running = false;
  let settings = loadTuiSettings().diagnostics;

  pi.on("session_start", () => {
    settings = loadTuiSettings().diagnostics;
    touched.clear();
  });
  pi.on("agent_start", () => touched.clear());
  pi.on("tool_result", (event) => {
    if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const p = event.input.path;
    if (typeof p === "string") touched.add(p);
  });

  pi.on("agent_settled", (event, ctx) => {
    if (!settings.enabled || running || event.aborted || !touched.size) return;
    const files = [...touched];
    touched.clear();
    const checker = detectChecker(ctx.cwd, files, settings.command);
    if (!checker) return;
    running = true;
    // Read ctx now: the check finishes after the run, and in print mode the
    // session may be gone by then, which makes every ctx getter throw.
    const cwd = ctx.cwd;
    const ui = ctx.hasUI ? ctx.ui : undefined;
    ui?.setStatus(STATUS, `checking: ${checker.label}…`);
    void run(cwd, ui, checker, files).finally(() => {
      running = false;
      ui?.setStatus(STATUS, undefined);
    });
  });

  async function run(cwd: string, ui: ExtensionContext["ui"] | undefined, checker: Checker, files: string[]) {
    try {
      const r = await pi.exec(checker.command, checker.args, { cwd, timeout: TIMEOUT_MS });
      if (r.code === 0) return;
      const out = filterToTouched(`${r.stdout}\n${r.stderr}`, files, cwd, Boolean(settings.command));
      if (!out.trim()) return;
      pi.sendMessage(
        {
          customType: "b4agent-diagnostics",
          content: `[diagnostics] \`${checker.label}\` failed after your edits:\n\n${out}\n\nFix these, or tell the user why they are expected.`,
          display: true,
          details: { checker: checker.label, files },
        },
        { deliverAs: "nextTurn" },
      );
      ui?.notify(`${checker.label} found problems; the agent sees them next turn.`, "warning");
    } catch {
      // A missing or hung checker is not the agent's problem.
    }
  }
}
