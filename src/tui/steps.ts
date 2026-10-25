/**
 * Collapsed agent steps (plan section 25): a run of tool calls becomes one
 * line like "Ran 5 commands, read 2 files, edited 2 files (+40 -7), ran 1
 * search". Shared by the main transcript and the subagent overlay.
 */

export interface Step {
  tool: string;
  args: Record<string, unknown>;
  /** Undefined while the call is still running. */
  result?: { isError: boolean; details?: unknown; content?: unknown };
}

interface Bucket {
  verb: string;
  one: string;
  many: string;
  keys: Set<string>;
  calls: number;
  added: number;
  removed: number;
  /** A tool without a phrase, shown by its name ("used github_search ×2"). */
  named: boolean;
}

const KIND: Record<string, [verb: string, one: string, many: string]> = {
  bash: ["ran", "command", "commands"],
  read: ["read", "file", "files"],
  edit: ["edited", "file", "files"],
  write: ["edited", "file", "files"],
  grep: ["ran", "search", "searches"],
  find: ["ran", "search", "searches"],
  ls: ["listed", "folder", "folders"],
  agent: ["started", "agent", "agents"],
  message: ["sent", "message", "messages"],
  ask_user: ["asked", "question", "questions"],
  exit_spec: ["presented", "spec", "specs"],
  set_schedule: ["scheduled", "task", "tasks"],
  update_schedule: ["scheduled", "task", "tasks"],
  get_schedule: ["checked", "schedule", "schedules"],
  clear_schedule: ["cleared", "schedule", "schedules"],
  web_search: ["ran", "web search", "web searches"],
  web_fetch: ["fetched", "page", "pages"],
  session_search: ["searched", "past session list", "past session lists"],
  session_read: ["read", "past session", "past sessions"],
  painter: ["generated", "image", "images"],
  agents: ["checked on", "agent", "agents"],
  agent_create: ["created", "agent type", "agent types"],
  ask: ["asked", "question", "questions"],
  report: ["sent", "progress note", "progress notes"],
  submit: ["submitted", "result", "results"],
};

/** The argument that names what a call touches: the same file, page or session counts once however often it's touched. Other calls count per call. */
const KEY_ARG: Record<string, string> = { read: "path", edit: "path", write: "path", ls: "path", web_fetch: "url", session_read: "session", agents: "name" };

export interface StepSummary {
  /** "Ran 5 commands, read 2 files, edited 2 files (+40 -7)". */
  text: string;
  failed: number;
  running: number;
  /** The call still running, for live progress ("npm test"). */
  current?: string;
}

export function summarizeSteps(steps: readonly Step[]): StepSummary {
  const buckets = new Map<string, Bucket>();
  let failed = 0;
  let running = 0;
  let current: string | undefined;
  for (const s of steps) {
    const name = s.tool.toLowerCase();
    // Tools without a phrase (MCP and extension tools) are named, so the line still says what ran.
    const kind = KIND[name];
    const [verb, one, many] = kind ?? ["used", s.tool, s.tool];
    const id = `${kind ? "" : "tool:"}${verb} ${many}`;
    const b = buckets.get(id) ?? { verb, one, many, keys: new Set(), calls: 0, added: 0, removed: 0, named: !kind };
    buckets.set(id, b);
    b.calls++;
    const keyArg = KEY_ARG[name];
    const key = keyArg && typeof s.args[keyArg] === "string" ? (s.args[keyArg] as string) : undefined;
    b.keys.add(key ?? `#${b.calls}`);
    if (!s.result) {
      running++;
      current = describe(s);
    } else if (s.result.isError) failed++;
    else if (name === "edit" || name === "write") {
      const [a, r] = lineDelta(name, s);
      b.added += a;
      b.removed += r;
    }
  }
  const parts = [...buckets.values()].map((b) => {
    const n = b.keys.size;
    if (b.named) return `used ${b.one}${n > 1 ? ` ×${n}` : ""}`;
    const diff = b.added || b.removed ? ` (+${b.added} -${b.removed})` : "";
    return `${b.verb} ${n} ${n === 1 ? b.one : b.many}${diff}`;
  });
  const text = parts.join(", ");
  return { text: text.charAt(0).toUpperCase() + text.slice(1), failed, running, ...(current ? { current } : {}) };
}

/** Lines added and removed by an edit (from its patch) or a write (its content). */
function lineDelta(name: string, s: Step): [number, number] {
  if (name === "write") {
    const c = s.args.content;
    return [typeof c === "string" && c.length ? c.replace(/\n$/, "").split("\n").length : 0, 0];
  }
  const patch = (s.result?.details as { patch?: unknown } | undefined)?.patch;
  if (typeof patch !== "string") return [0, 0];
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return [added, removed];
}

/** One short phrase for a call: its command, path or pattern. */
export function describe(s: Step): string {
  const a = s.args;
  for (const k of ["command", "path", "pattern", "prompt", "query", "url"]) {
    const v = a[k];
    if (typeof v === "string" && v.trim()) return `${s.tool} ${v.trim().split("\n")[0]!.slice(0, 80)}`;
  }
  return s.tool;
}

/** A transcript message, as the overlay reads it from a session. */
export interface Msg {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
  stopReason?: string;
}

export type Block =
  | { kind: "message"; message: Msg }
  /** A run of steps with the messages it folds (narration between calls, tool results). */
  | { kind: "steps"; steps: Step[]; messages: Msg[] };

/**
 * Folds each run of tool calls between user messages into one block. Assistant
 * text after the run's last call (the answer) stays outside it; text between
 * calls is a step. Error and aborted messages always stay outside.
 */
export function groupMessages(messages: readonly Msg[]): Block[] {
  const out: Block[] = [];
  let run: Msg[] = [];
  const flush = () => {
    const lastCall = run.findLastIndex((m) => m.role === "toolResult" || hasToolCalls(m));
    if (lastCall < 0) {
      for (const m of run) out.push({ kind: "message", message: m });
    } else {
      // Results come after their call, so the run ends at the last result of the last call.
      let end = lastCall;
      while (end + 1 < run.length && run[end + 1]!.role === "toolResult") end++;
      const folded = run.slice(0, end + 1);
      out.push({ kind: "steps", steps: stepsOf(folded), messages: folded });
      for (const m of run.slice(end + 1)) out.push({ kind: "message", message: m });
    }
    run = [];
  };
  for (const m of messages) {
    const foldable = m.role === "toolResult" || (m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted");
    if (foldable) run.push(m);
    else {
      flush();
      out.push({ kind: "message", message: m });
    }
  }
  flush();
  return out;
}

function hasToolCalls(m: Msg): boolean {
  return m.role === "assistant" && Array.isArray(m.content) && (m.content as { type: string }[]).some((c) => c.type === "toolCall");
}

function stepsOf(messages: readonly Msg[]): Step[] {
  const results = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const steps: Step[] = [];
  for (const m of messages) {
    if (!hasToolCalls(m)) continue;
    for (const c of m.content as { type: string; id: string; name: string; arguments?: Record<string, unknown> }[]) {
      if (c.type !== "toolCall") continue;
      const r = results.get(c.id);
      steps.push({ tool: c.name, args: c.arguments ?? {}, ...(r ? { result: { isError: Boolean(r.isError), details: r.details, content: r.content } } : {}) });
    }
  }
  return steps;
}
