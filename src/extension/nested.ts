import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type Candidate,
  directoryCandidates,
  isInstructionName,
  isWholeRead,
  keyFor,
  type Ledger,
  type LedgerEntry,
  ledgerFrom,
  planInjection,
  realpathOr,
  type Touch,
  touchesFor,
} from "../context/nested.js";
import { loadRules, ruleCandidates } from "../context/rules.js";

/**
 * Subdirectory AGENTS.md on demand (plan section 19). After a successful
 * read, edit, write, ls, grep, find or bash call, the instruction files
 * between cwd (exclusive) and the touched path are appended to the tool
 * result, outer to inner, once per file per context window. The cached
 * prefix stays intact. Main sessions and subagents both load this.
 */
export default function nested(pi: ExtensionAPI, opts: { argv?: string[] } = {}) {
  // Pi doesn't expose --no-context-files to extensions; when the user turned context files off, nested ones stay off too.
  const argv = opts.argv ?? process.argv;
  if (argv.includes("--no-context-files") || argv.includes("-nc")) return;
  /** Blocks appended to results that may not be in the session yet (parallel calls), by tool call id. */
  const inFlight = new Map<string, Map<string, LedgerEntry>>();

  const reset = () => inFlight.clear();
  pi.on("session_start", reset);
  pi.on("session_tree", reset);
  pi.on("session_compact", reset);
  pi.on("agent_end", reset);

  function currentLedger(ctx: ExtensionContext, cwd: string, realCwd: string, isRuleKey: (k: string) => boolean): Ledger {
    const branch = ctx.sessionManager.getBranch();
    const ledger = ledgerFrom(buildSessionContext(branch).messages, cwd, realCwd, isRuleKey);
    const persisted = new Set<string>();
    for (const e of branch) if (e.type === "message" && e.message.role === "toolResult") persisted.add(e.message.toolCallId);
    for (const [id, entries] of inFlight) {
      if (persisted.has(id)) {
        inFlight.delete(id);
        continue;
      }
      for (const [k, v] of entries) ledger.set(k, v);
    }
    return ledger;
  }

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    const cwd = ctx.cwd;
    const realCwd = realpathOr(cwd);
    const touches = touchesFor(event.toolName, event.input, cwd);
    if (!touches.length) return;

    const rules = loadRules(realCwd);
    const ruleKeys = new Set(rules.map((r) => r.key));
    const candidates: Candidate[] = [...ruleCandidates(rules, touchedFiles(touches), realCwd), ...directoryCandidates(touches, realCwd)];

    // A whole-file read of an instruction file gives the model its text: count it, and don't append it again.
    const own = new Map<string, LedgerEntry>();
    if (event.toolName === "read" && isWholeRead(event.input)) {
      const t = touches[0]!;
      const key = keyFor(t.path, realCwd);
      if (isInstructionName(basename(t.path)) || ruleKeys.has(key)) own.set(key, { direct: true, bytes: 0 });
    }
    if (!candidates.length) {
      if (own.size) inFlight.set(event.toolCallId, own);
      return;
    }

    const ledger = currentLedger(ctx, cwd, realCwd, (k) => ruleKeys.has(k));
    for (const [k, v] of own) ledger.set(k, v);
    const { blocks, injected } = planInjection(candidates, ledger, { trusted: ctx.isProjectTrusted() });
    for (const [k, v] of injected) own.set(k, v);
    if (own.size) inFlight.set(event.toolCallId, own);
    if (!blocks.length) return;
    return { content: [...event.content, { type: "text" as const, text: blocks.join("\n\n") }] };
  });
}

/** Touched files as real paths (for rule globs). */
function touchedFiles(touches: Touch[]): string[] {
  const out: string[] = [];
  for (const t of touches) {
    if (t.kind === "dir") continue;
    if (t.kind === "either") {
      try {
        if (statSync(t.path).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    out.push(join(realpathOr(dirname(t.path)), basename(t.path)));
  }
  return out;
}
