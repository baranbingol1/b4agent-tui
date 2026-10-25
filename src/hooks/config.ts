import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { extract } from "../permissions/shell/commands.js";
import { headName } from "../permissions/shell/unwrap.js";
import { staticValue } from "../permissions/shell/words.js";

/**
 * Settings-defined shell hooks in Claude Code's format
 * (https://code.claude.com/docs/en/hooks), so existing hooks can be reused:
 *
 *   { "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "..." } ] } ] } }
 *
 * Read from `hooks` in ~/.b4agent/b4agent.json and in the project's
 * `.pi/b4agent.json` (the project config b4agent already reads; plan
 * section 0). Only command hooks run; http, prompt, agent and mcp_tool
 * handlers are listed as skipped.
 */

export const EVENTS = [
  "PreToolUse", "PostToolUse", "PostToolUseFailure", "UserPromptSubmit", "Stop", "SubagentStart", "SubagentStop",
  "SessionStart", "SessionEnd", "PreCompact", "Notification",
] as const;
export type HookEvent = (typeof EVENTS)[number];

export type Source = "global" | "project";

export interface CommandHook {
  event: HookEvent;
  matcher: string;
  command: string;
  /** Exec form: `command` is spawned directly with these arguments, no shell. */
  args?: string[];
  /** Seconds. */
  timeout?: number;
  statusMessage?: string;
  /** Claude Code's permission-rule filter for tool events, such as `Bash(git *)`. */
  if?: string;
  /** "block": a hook that fails to start, times out or exits with another code blocks like exit 2. */
  onFailure?: "continue" | "block";
  source: Source;
  file: string;
}

export interface Skipped {
  what: string;
  why: string;
  source: Source;
  file: string;
}

export interface HookConfig {
  hooks: CommandHook[];
  skipped: Skipped[];
  errors: string[];
}

/** Events Claude Code has that b4agent can't map onto a Pi event. */
const UNMAPPED = new Set([
  "Setup", "UserPromptExpansion", "PermissionRequest", "PermissionDenied", "PostToolBatch", "MessageDisplay", "TaskCreated", "TaskCompleted",
  "StopFailure", "TeammateIdle", "InstructionsLoaded", "ConfigChange", "CwdChanged", "DirectoryAdded", "FileChanged", "WorktreeCreate",
  "WorktreeRemove", "PostCompact", "PreModelSwitch", "PostModelSwitch", "Elicitation", "ElicitationResult", "Interrupt",
]);

function readJson(path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    errors.push(`${path}: not a JSON object`);
  } catch (e) {
    errors.push(`could not parse ${path}: ${(e as Error).message}`);
  }
  return undefined;
}

/** Parses the `hooks` object of one settings file. */
export function parseHooks(raw: unknown, source: Source, file: string, out: HookConfig): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.errors.push(`${file}: "hooks" must be an object keyed by event name`);
    return;
  }
  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!(EVENTS as readonly string[]).includes(event)) {
      out.skipped.push({ what: event, why: UNMAPPED.has(event) ? "event not supported by b4agent" : "unknown event", source, file });
      continue;
    }
    if (!Array.isArray(groups)) {
      out.errors.push(`${file}: hooks.${event} must be a list of matcher groups`);
      continue;
    }
    for (const g of groups) {
      const group = (g ?? {}) as Record<string, unknown>;
      const matcher = typeof group.matcher === "string" ? group.matcher : "";
      if (!Array.isArray(group.hooks)) {
        out.errors.push(`${file}: hooks.${event}[].hooks must be a list`);
        continue;
      }
      for (const h of group.hooks) {
        const o = (h ?? {}) as Record<string, unknown>;
        const label = `${event}${matcher ? ` (${matcher})` : ""}: ${typeof o.command === "string" ? o.command : String(o.type)}`;
        if (o.type !== "command") {
          out.skipped.push({ what: label, why: `"${String(o.type)}" hooks are not supported; only "command"`, source, file });
          continue;
        }
        if (typeof o.command !== "string" || !o.command.trim()) {
          out.errors.push(`${file}: a ${event} command hook has no "command"`);
          continue;
        }
        if (o.async === true || o.asyncRewake === true) {
          out.skipped.push({ what: label, why: "async hooks are not supported", source, file });
          continue;
        }
        if (o.shell === "powershell") {
          out.skipped.push({ what: label, why: "PowerShell hooks are not supported", source, file });
          continue;
        }
        const hook: CommandHook = { event: event as HookEvent, matcher, command: o.command, source, file };
        if (Array.isArray(o.args)) hook.args = o.args.filter((a): a is string => typeof a === "string");
        if (typeof o.timeout === "number" && o.timeout > 0) hook.timeout = o.timeout;
        if (typeof o.statusMessage === "string") hook.statusMessage = o.statusMessage;
        if (typeof o.if === "string" && o.if.trim()) hook.if = o.if.trim();
        if (o.onFailure === "block" || o.onFailure === "continue") hook.onFailure = o.onFailure;
        out.hooks.push(hook);
      }
    }
  }
}

/**
 * Global hooks always; project hooks only when `trusted`. `disableAllHooks`
 * in the global file turns every hook off; in the project file, the
 * project's own.
 */
export function loadHooks(b4agentHome: string, projectRoot: string | undefined, trusted: boolean): HookConfig & { projectFile?: string; projectHooksIgnored: boolean } {
  const out: HookConfig = { hooks: [], skipped: [], errors: [] };
  const globalFile = join(b4agentHome, "b4agent.json");
  const g = readJson(globalFile, out.errors);
  let projectHooksIgnored = false;
  if (g?.disableAllHooks === true) return { ...out, projectHooksIgnored };
  parseHooks(g?.hooks, "global", globalFile, out);
  const projectFile = projectRoot ? join(projectRoot, ".pi", "b4agent.json") : undefined;
  if (projectFile && existsSync(projectFile)) {
    if (!trusted) {
      projectHooksIgnored = readJson(projectFile, [])?.hooks !== undefined;
    } else {
      const p = readJson(projectFile, out.errors);
      if (p?.disableAllHooks !== true) parseHooks(p?.hooks, "project", projectFile, out);
    }
  }
  return { ...out, ...(projectFile ? { projectFile } : {}), projectHooksIgnored };
}

// ---------------------------------------------------------------------------
// Tool names: Claude Code's names map onto Pi's, and Pi's own still match.

const CLAUDE_NAMES: Record<string, string> = {
  bash: "Bash", edit: "Edit", write: "Write", read: "Read", grep: "Grep", find: "Glob", ls: "LS",
  web_fetch: "WebFetch", web_search: "WebSearch", agent: "Agent", ask_user: "AskUserQuestion", exit_spec: "ExitPlanMode",
};
/** Older or other harnesses' names for the same tools (Claude Code's `Task`, Droid's `Execute`/`Create`). */
const EXTRA_NAMES: Record<string, string[]> = { agent: ["Task"], bash: ["Execute"], write: ["Create"], ls: ["LS"] };

/** The name hooks see in `tool_name`: Claude Code's for tools it has, Pi's otherwise. */
export function hookToolName(piName: string): string {
  return CLAUDE_NAMES[piName] ?? piName;
}

/** Every name a matcher may use for a Pi tool. */
export function toolAliases(piName: string): string[] {
  return [...new Set([piName, hookToolName(piName), ...(EXTRA_NAMES[piName] ?? [])])];
}

/**
 * Claude Code's matcher rules: empty or `*` matches everything; only letters,
 * digits, `_`, `-`, spaces, `,` and `|` is a list of exact names; anything else
 * is an unanchored JavaScript regular expression. A bad regex matches nothing.
 */
export function matches(matcher: string, values: string[]): boolean {
  const m = matcher.trim();
  if (m === "" || m === "*") return true;
  if (/^[A-Za-z0-9_\-\s,|]+$/.test(m)) {
    const names = m.split(/[|,]/).map((s) => s.trim()).filter(Boolean);
    return values.some((v) => names.includes(v));
  }
  try {
    const re = new RegExp(m);
    return values.some((v) => re.test(v));
  } catch {
    return false;
  }
}

/** Events whose matcher Claude Code ignores. */
export const NO_MATCHER = new Set<HookEvent>(["UserPromptSubmit", "Stop"]);
const TOOL_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);

// ---------------------------------------------------------------------------
// `if`: one permission rule, `Tool` or `Tool(pattern)`. Best effort, as in
// Claude Code: when the call can't be judged, the hook runs.

const globToRegex = (glob: string) => new RegExp(`^${glob.replace(/[.+?^${}()[\]\\|]/g, "\\$&").replace(/\*/g, "[\\s\\S]*")}$`);

function bashCommandMatches(command: string, pattern: string, cwd: string): boolean {
  // Legacy `npm run test:*` means "starts with `npm run test`".
  const p = pattern.endsWith(":*") ? `${pattern.slice(0, -2)}*` : pattern;
  const re = globToRegex(p);
  const bare = p.endsWith(" *") ? globToRegex(p.slice(0, -2)) : undefined;
  let ext;
  try {
    ext = extract(command, cwd, homedir());
  } catch {
    return true;
  }
  if (ext.errors.length || ext.tooDeep) return true;
  for (const c of ext.commands) {
    const words = c.argv.map(staticValue);
    // A command whose words can't be known (`$X`, `$(...)`) may be anything.
    if (words.some((w) => w === undefined)) {
      if (/^[^*\s]+ [^*]/.test(p)) return true;
      const head = headName(c.argv[0]);
      if (head === undefined || re.test(head) || bare?.test(head)) return true;
      continue;
    }
    const text = (words as string[]).join(" ");
    if (re.test(text) || bare?.test(text)) return true;
  }
  return false;
}

function pathMatches(path: string, pattern: string, cwd: string, projectDir: string): boolean {
  const home = process.env.HOME ?? homedir();
  const abs = isAbsolute(path) ? path : resolve(cwd, path.startsWith("~/") ? join(home, path.slice(2)) : path);
  let glob: string;
  if (pattern.startsWith("//")) glob = pattern.slice(1);
  else if (pattern.startsWith("~/")) glob = join(home, pattern.slice(2));
  else if (pattern.startsWith("/")) glob = join(projectDir, pattern.slice(1));
  else if (!pattern.includes("/")) glob = `**/${pattern}`;
  else glob = join(cwd, pattern);
  if (!isAbsolute(glob)) {
    const rel = relative(cwd, abs);
    return matchesGlob(rel, glob);
  }
  return matchesGlob(abs, glob);
}

/** Whether a hook's `if` lets it run for this event. On non-tool events a hook with `if` never runs. */
export function ifAllows(rule: string | undefined, event: HookEvent, tool: { name: string; input: Record<string, unknown> } | undefined, cwd: string, projectDir: string): boolean {
  if (!rule) return true;
  if (!TOOL_EVENTS.has(event) || !tool) return false;
  const m = /^([^()]+?)\s*(?:\((.*)\))?$/s.exec(rule);
  if (!m) return true;
  const [, name, pattern] = m;
  if (!toolAliases(tool.name).includes(name!.trim())) return false;
  if (pattern === undefined || pattern === "" || pattern === "*") return true;
  if (tool.name === "bash" && typeof tool.input.command === "string") return bashCommandMatches(tool.input.command, pattern, cwd);
  const path = typeof tool.input.path === "string" ? tool.input.path : undefined;
  if (path && ["read", "write", "edit", "grep", "find", "ls"].includes(tool.name)) return pathMatches(path, pattern, cwd, projectDir);
  if (tool.name === "web_fetch" && typeof tool.input.url === "string" && pattern.startsWith("domain:")) {
    try {
      const host = new URL(tool.input.url).hostname;
      const want = pattern.slice(7);
      return host === want || host.endsWith(`.${want}`);
    } catch {
      return true;
    }
  }
  return true;
}

/** What each event's matcher is tested against. */
export function matcherValues(event: HookEvent, value: string | undefined): string[] {
  if (value === undefined) return [];
  return TOOL_EVENTS.has(event) ? toolAliases(value) : [value];
}

/** The hooks that run for one occurrence of an event, each distinct command once (Claude Code dedupes across files). */
export function select(
  hooks: readonly CommandHook[],
  event: HookEvent,
  value: string | undefined,
  tool?: { name: string; input: Record<string, unknown> },
  cwd = process.cwd(),
  projectDir = cwd,
): CommandHook[] {
  const seen = new Set<string>();
  const out: CommandHook[] = [];
  const values = matcherValues(event, value);
  for (const h of hooks) {
    if (h.event !== event) continue;
    if (!NO_MATCHER.has(event) && !matches(h.matcher, values)) continue;
    if (!ifAllows(h.if, event, tool, cwd, projectDir)) continue;
    const key = JSON.stringify([h.command, h.args ?? null, h.if ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}
