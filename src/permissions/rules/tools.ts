import { posix } from "node:path";
import { sessionDirName } from "../../history/paths.js";
import { classifyRead, classifyWrite, isInside, resolvePath } from "../paths.js";
import type { PermissionContext, Verdict } from "../types.js";
import { classifyBash } from "./bash.js";
import { classifyWebFetch, classifyWebSearch } from "./web.js";

export interface ToolInfo {
  /** MCP-style hints, when the tool declares them. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["edit", "write"]);
/** b4agent's agent coordination tools: they act on no files themselves, and every agent's own tool calls pass this gate. */
const AGENT_TOOLS = new Set(["agent", "message", "agents", "submit", "report", "ask"]);
/** b4agent tools that only talk to the user or the harness. */
const HARNESS_TOOLS = new Set(["ask_user", "exit_spec", "set_schedule", "get_schedule", "update_schedule", "clear_schedule"]);

/** Classifies a tool call before it runs. */
export function classifyToolCall(toolName: string, input: Record<string, unknown>, ctx: PermissionContext, info: ToolInfo = {}): Verdict {
  const name = toolName.toLowerCase();
  if (name === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return classifyBash(command, ctx);
  }
  if (READ_TOOLS.has(name)) {
    const raw = typeof input.path === "string" && input.path !== "" ? input.path : ".";
    const p = resolvePath(raw, ctx.cwd, ctx.home);
    const v = p ? classifyRead(p, ctx) : { level: "allow" as const, rule: "read", reason: "read" };
    // Listing a credential store shows names, not secrets.
    if (v.rule === "credentials" && (name === "ls" || name === "find")) return { level: "review", rule: "credential-metadata", reason: `${name} lists a credential store without reading it: ${p}` };
    return v;
  }
  if (WRITE_TOOLS.has(name)) {
    if (typeof input.path !== "string" || input.path === "") return { level: "review", rule: "write", reason: `${name} without a path` };
    const p = resolvePath(input.path, ctx.cwd, ctx.home)!;
    return { ...classifyWrite(p, ctx, name), targets: [p] };
  }
  if (name === "agent_create") return classifyAgentCreate(input, ctx);
  if (name === "web_fetch") return classifyWebFetch(input, ctx);
  if (name === "web_search") return classifyWebSearch();
  if (name === "session_search" || name === "session_read") return classifySessionTool(name, input, ctx);
  // Like a subagent on the slow model: it sends the conversation to a configured model and runs nothing.
  if (HARNESS_TOOLS.has(name)) return { level: "allow", rule: "harness", reason: `${toolName} only talks to the user or b4agent` };
  if (AGENT_TOOLS.has(name)) {
    // Applying a worktree agent's patch edits the checkout, like the agent's own edits would have.
    if (name === "agents" && input.action === "apply") return { level: "auto", rule: "agents-apply", reason: "applies a subagent's worktree patch to the checkout" };
    return { level: "allow", rule: "agents", reason: "coordinates agents; their own tool calls pass the gate" };
  }
  if (info.annotations?.readOnlyHint === true && info.annotations.destructiveHint !== true) {
    return { level: "allow", rule: "read-only-tool", reason: `${toolName} declares itself read-only` };
  }
  return { level: "review", rule: "tool", reason: `${toolName} is not a built-in read or edit tool` };
}

/**
 * session_search and session_read only read b4agent's own session files
 * (plan section 2, the historian). Other projects' sessions are allowed only
 * when the call says `scope: "all"`, so a call that names one by path without
 * it is refused (the tool checks the session's folder too). A path outside
 * the sessions folder is judged like `read` of that file.
 */
function classifySessionTool(name: string, input: Record<string, unknown>, ctx: PermissionContext): Verdict {
  const all = input.scope === "all";
  const ok: Verdict = all
    ? { level: "allow", rule: "session-history-all", reason: `${name} reads past sessions of any project (scope: "all")` }
    : { level: "allow", rule: "session-history", reason: `${name} reads this project's past sessions` };
  const ref = name === "session_read" && typeof input.session === "string" ? input.session.trim() : "";
  if (!ref.includes("/") && !ref.endsWith(".jsonl")) return ok;
  const p = resolvePath(ref, ctx.cwd, ctx.home);
  if (!p) return ok;
  const root = posix.join(ctx.b4agentDir, "agent", "sessions");
  if (!isInside(p, root) || p === root) return classifyRead(p, ctx);
  if (all) return ok;
  const dir = posix.relative(root, p).split("/")[0]!;
  const own = sessionDirName(ctx.workspace);
  if (dir === own || dir.startsWith(own.slice(0, -2) + "-") || dir === sessionDirName(ctx.cwd)) return ok;
  return { level: "deny", rule: "session-other-project", reason: `${p} is a session of another project`, fix: 'Pass scope: "all" to read sessions of other projects.' };
}

/**
 * agent_create writes `<name>.md` into `.pi/agents/` or `~/.b4agent/agents/`,
 * both protected paths. The tool shows the user the exact file and needs
 * their approval in every mode, yolo included, so the gate doesn't ask a
 * second time: it rates the call like an edit (`auto`), which keeps it out
 * of spec mode and asks in manual mode. A name that could leave the agents
 * folder is refused before any path is built from it.
 */
function classifyAgentCreate(input: Record<string, unknown>, ctx: PermissionContext): Verdict {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return { level: "deny", rule: "agent-create-name", reason: "agent_create needs a type name of lowercase letters, digits and dashes", fix: "Use a plain name such as test-runner." };
  }
  const dir = input.scope === "project" ? posix.join(ctx.workspace, ".pi", "agents") : posix.join(ctx.b4agentDir, "agents");
  const target = posix.join(dir, `${name}.md`);
  const write = classifyWrite(target, ctx, "agent_create");
  // Only rules stricter than the protected folder itself win: the guard's own files, or a symlink into a credential store.
  if (write.level === "deny" || write.rule === "credentials") return { ...write, targets: [target] };
  return { level: "auto", rule: "agent-create", reason: `writes the subagent type ${target} after the user approves the file`, targets: [target] };
}
