import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type ExtensionUIContext,
  type FileEntry,
  SessionManager,
  SettingsManager,
  type CustomMessageEntryDraft,
} from "@earendil-works/pi-coding-agent";
import { type B4Config, type Complexity, resolveModel } from "../config.js";
import { forceToolChoice, MAX_SUBMIT_REMINDERS, type OutputSchema, reminderText } from "./schema.js";
import { type AgentType, modelCandidates } from "./types.js";
import { applyPatch, capturePatch, createWorktree, type Patch, removeWorktree, type Worktree } from "./worktree.js";
import { logSideUsage, type SideUsage } from "../usage-log.js";

/**
 * The agent hub (plan sections 2 and 11): every subagent in this session
 * runs in-process as its own AgentSession, addressable by name. Any agent
 * can message any other; results, questions and finished bash jobs are
 * delivered to whoever started them.
 *
 * Delivery: to an idle agent it starts a turn; to a busy one it lands at
 * the next turn boundary (Pi's steer). Results that finish together are
 * batched into one message (tintinweb, oh-my-pi).
 */

export type Status = "starting" | "running" | "idle" | "waiting" | "failed" | "stopped";
export const MAIN = "main";

export interface AgentRecord {
  name: string;
  type: string;
  depth: number;
  /** Who started it: "main" or another agent's name. Results go there. */
  parent: string;
  status: Status;
  prompt: string;
  model: string;
  cwd: string;
  worktree?: Worktree;
  patch?: Patch & { applied?: boolean };
  session?: AgentSession;
  startedAt: number;
  endedAt?: number;
  /** Result of the latest finished run. */
  result?: string;
  /** Set by `submit` during the current run. */
  submitted?: string;
  /** Set by `submit` with the schema-checked `data`. */
  submittedData?: unknown;
  /** The latest result's structured data, when it had any. */
  data?: unknown;
  /** The JSON Schema its `submit` data must match (the call's, else the type's `output`). */
  schema?: OutputSchema;
  /** Submit reminders sent in the current run. */
  reminders: number;
  /** The next provider request forces the submit tool. */
  forceSubmit?: boolean;
  /** Set by `ask` during the current run. */
  asked?: string;
  error?: string;
  reports: { at: number; text: string }[];
  /** What it's doing right now, for the panel. */
  activity?: string;
  /** A dialog from this agent is waiting for the user. */
  needsUser?: boolean;
  runs: number;
  /** The current run's result was already handed back (foreground call or `agents wait`). */
  claimed?: boolean;
  tokens: number;
  cost: number;
  /** The child's session file, when it is saved (fresh children in the shared checkout). */
  file?: string;
  /** Restored from an earlier run of this session: its conversation loads on the next message. */
  dormant?: boolean;
  turns: number;
  overBudget?: boolean;
  lastReportAt?: number;
}

export interface BashJob {
  id: string;
  owner: string;
  command: string;
  cwd: string;
  status: "running" | "done" | "failed" | "killed";
  exitCode?: number | null;
  log: string;
  startedAt: number;
  endedAt?: number;
  kill(): void;
}

/** What the root extension provides: its current context and how to post into the main conversation. */
export interface RootLink {
  pi: ExtensionAPI;
  ctx(): ExtensionContext | undefined;
}

/** Passed to b4agent's extensions inside a child session. */
export interface ChildHandle {
  name: string;
  hub: Hub;
}

export type ExtensionMaker = (opts: { child?: ChildHandle }) => ExtensionFactory;

type Listener = () => void;

const HOLD_MS = 200;
const MAX_MESSAGE_CHARS = 32_000;
/** Results over this go to a file with an inline preview (plan section 2). */
const MAX_INLINE_RESULT = 12_000;
const REPORT_CHARS = 512;
const REPORT_EVERY_MS = 10_000;
const AGENT_ENTRY = "b4agent-agent";
const AGENT_DONE_ENTRY = "b4agent-agent-done";

export class Hub {
  readonly agents = new Map<string, AgentRecord>();
  /** Bumped when the type set changes (agent_create), so prompt sections rebuild only then. */
  typesVersion = 0;
  readonly jobs = new Map<string, BashJob>();
  private readonly listeners = new Set<Listener>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly outbox: string[] = [];
  private outboxTimer: NodeJS.Timeout | undefined;
  private counters = new Map<string, number>();
  private jobCounter = 0;
  private disposed = false;

  constructor(
    readonly root: RootLink,
    readonly config: B4Config,
    /** Replaced in place by `replaceTypes`, so children holding it see new types too. */
    readonly types: Map<string, AgentType>,
    readonly b4agentDir: string,
    readonly agentDir: string,
    private readonly makeExtension: ExtensionMaker,
  ) {}

  /** Hot reload (plan section 2): the new set is usable at once; prompt sections follow on the next run. */
  replaceTypes(next: Map<string, AgentType>): boolean {
    const sig = (m: Map<string, AgentType>) => JSON.stringify([...m.values()].map((t) => [t.name, t.description, t.tools, t.isolation, t.locked, t.output !== undefined, t.source]));
    const same = sig(next) === sig(this.types);
    this.types.clear();
    for (const [k, v] of next) this.types.set(k, v);
    if (!same) this.typesVersion++;
    this.changed();
    return !same;
  }

  onChange(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  changed() {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a listener must not break the hub
      }
    }
  }

  depthOf(name: string): number {
    return name === MAIN ? 0 : (this.agents.get(name)?.depth ?? 0);
  }

  running(): AgentRecord[] {
    return [...this.agents.values()].filter((a) => a.status === "running" || a.status === "starting");
  }

  /** Tokens and cost over every subagent in this session (plan section 11). */
  totals(): { tokens: number; cost: number } {
    let tokens = 0;
    let cost = 0;
    for (const a of this.agents.values()) {
      tokens += a.tokens;
      cost += a.cost;
    }
    return { tokens, cost };
  }

  /** True while any subagent or background bash job is working. */
  busy(): boolean {
    return this.running().length > 0 || [...this.jobs.values()].some((j) => j.status === "running");
  }

  /** An explicit name is used as given when free; otherwise `<type>-<n>`. */
  private uniqueName(base: string, explicit: boolean): string {
    const clean = base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
    if (explicit && clean !== MAIN && !this.agents.has(clean)) return clean;
    let n = this.counters.get(clean) ?? 0;
    let name: string;
    do name = `${clean}-${++n}`;
    while (this.agents.has(name));
    this.counters.set(clean, n);
    return name;
  }

  // ---------------------------------------------------------------- delivery

  /** Posts text into an agent's conversation: starts a turn if idle, steers if busy. */
  async deliver(to: string, text: string, opts: { trigger?: boolean; customType?: string } = {}): Promise<void> {
    const trigger = opts.trigger ?? true;
    if (this.disposed) return;
    if (to === MAIN) {
      if (!trigger) {
        this.root.pi.sendMessage({ customType: opts.customType ?? "b4agent-agents", content: text, display: true }, { deliverAs: "nextTurn" });
        return;
      }
      this.outbox.push(text);
      this.outboxTimer ??= setTimeout(() => this.flushOutbox(), HOLD_MS);
      return;
    }
    const rec = this.agents.get(to);
    if (!rec) throw new Error(`no agent named ${to}`);
    const session = await this.ensureSession(rec);
    await session.sendCustomMessage(
      { customType: opts.customType ?? "b4agent-message", content: text, display: true },
      trigger ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "nextTurn" },
    );
  }

  private flushOutbox() {
    this.outboxTimer = undefined;
    const items = this.outbox.splice(0);
    if (!items.length || this.disposed) return;
    try {
      this.root.pi.sendMessage({ customType: "b4agent-agents", content: items.join("\n\n---\n\n"), display: true }, { deliverAs: "steer", triggerTurn: true });
    } catch {
      // the main session was replaced
    }
  }

  /** `message` tool: the sender is stamped by the hub, so it can't be faked. */
  async message(from: string, to: string, text: string): Promise<string> {
    if (to === from) return "You can't message yourself.";
    if (text.length > MAX_MESSAGE_CHARS) return `Message is ${text.length} characters; put long content in a file and send its path.`;
    if (to !== MAIN && !this.agents.has(to)) return `No agent named "${to}". Agents: ${[MAIN, ...this.agents.keys()].join(", ")}.`;
    const target = to === MAIN ? undefined : this.agents.get(to);
    const wasRunning = target ? target.status === "running" || target.status === "starting" : !this.root.ctx()?.isIdle();
    if (target) {
      target.asked = undefined;
      target.claimed = false;
      if (target.status === "stopped" || target.status === "failed") target.status = "idle";
    }
    await this.deliver(to, `[message from ${from}]\n${text}`);
    this.changed();
    return wasRunning ? `delivered to ${to}; it sees it after its current step` : `delivered to ${to}; it started a new turn with its full context`;
  }

  /** You typing into an agent from the panel. */
  async userMessage(to: string, text: string): Promise<void> {
    const rec = this.agents.get(to);
    if (!rec) return;
    const session = await this.ensureSession(rec);
    rec.asked = undefined;
    rec.claimed = false;
    if (rec.status === "stopped" || rec.status === "failed") rec.status = "idle";
    if (session.isStreaming) await session.sendUserMessage(text, { deliverAs: "steer" });
    else void session.sendUserMessage(text).catch((e: unknown) => this.fail(rec, e));
  }

  /** Short and rate-limited (Prime Agent): one note per 10 s reaches the parent; the rest stay readable with `agents read`. */
  report(from: string, text: string): string {
    const rec = this.agents.get(from);
    if (!rec) return "Noted.";
    const note = text.trim().replace(/\s+/g, " ").slice(0, REPORT_CHARS);
    const now = Date.now();
    rec.reports.push({ at: now, text: note });
    this.changed();
    if (rec.lastReportAt && now - rec.lastReportAt < REPORT_EVERY_MS) return "Noted, but not forwarded: one note per 10 seconds reaches the agent that started you. Keep working.";
    rec.lastReportAt = now;
    void this.deliver(rec.parent, `[progress from ${from}] ${note}`, { trigger: false, customType: "b4agent-report" }).catch(() => undefined);
    return "Noted.";
  }

  // ---------------------------------------------------------------- children

  async start(opts: {
    caller: string;
    callerCtx: ExtensionContext;
    type: AgentType;
    prompt: string;
    name?: string;
    fork?: boolean;
    isolation?: "none" | "worktree";
    model?: string;
    complexity?: Complexity;
    thinking?: string;
    /** Overrides the type's `output` schema. */
    schema?: OutputSchema;
  }): Promise<AgentRecord> {
    const depth = this.depthOf(opts.caller) + 1;
    if (depth > this.config.maxDepth) throw new Error(`agents can nest ${this.config.maxDepth} deep; ${opts.caller} is already at depth ${depth - 1}`);
    const max = opts.type.maxCalls;
    if (max && [...this.agents.values()].filter((a) => a.type === opts.type.name).length >= max) {
      throw new Error(`${opts.type.name} can be started ${max} times per session and that's used up; continue on your own judgment`);
    }
    const name = this.uniqueName(opts.name ?? opts.type.name, Boolean(opts.name));
    const ctx = opts.callerCtx;
    // The first candidate with a login wins: the call's model, its complexity, the type's model, then the caller's.
    const specs = modelCandidates(opts.type, { ...(opts.model ? { model: opts.model } : {}), ...(opts.complexity ? { complexity: opts.complexity } : {}) }, this.config);
    let resolved: ReturnType<typeof resolveModel>;
    for (const spec of specs) if ((resolved = resolveModel(spec, this.config.roles, ctx.modelRegistry))) break;
    const model = resolved?.model ?? ctx.model;
    if (!model) throw new Error(`no model for ${specs.join(", ")} and the caller has none`);
    const schema = opts.schema ?? opts.type.output;
    const thinking = opts.thinking ?? resolved?.thinking ?? opts.type.thinking;

    let cwd = ctx.cwd;
    let worktree: Worktree | undefined;
    if ((opts.isolation ?? opts.type.isolation) === "worktree") {
      const root = gitRoot(ctx.cwd);
      if (!root) throw new Error('isolation "worktree" needs a git repository');
      worktree = await createWorktree(root, this.b4agentDir, name);
      cwd = join(worktree.path, relative(root, ctx.cwd));
    }

    const rec: AgentRecord = {
      name,
      type: opts.type.name,
      depth,
      parent: opts.caller,
      status: "starting",
      prompt: opts.prompt,
      model: `${model.provider}/${model.id}${thinking ? `:${thinking}` : ""}`,
      cwd,
      ...(worktree ? { worktree } : {}),
      startedAt: Date.now(),
      reports: [],
      runs: 0,
      turns: 0,
      tokens: 0,
      cost: 0,
      reminders: 0,
      ...(schema !== undefined ? { schema } : {}),
    };
    this.agents.set(name, rec);
    this.changed();

    try {
      const sessionManager = this.childSessionManager(rec, opts.fork ? ctx : undefined);
      rec.file = sessionManager.getSessionFile();
      await this.spawn(rec, sessionManager, ctx);
    } catch (e) {
      this.fail(rec, e);
      if (worktree) await removeWorktree(worktree).catch(() => undefined);
      this.agents.delete(name);
      this.changed();
      throw e;
    }
    // Saved children can be messaged again after a resume (plan section 11).
    if (rec.file && !worktree) {
      this.root.pi.appendEntry(AGENT_ENTRY, { name, type: rec.type, model: rec.model, file: rec.file, cwd, parent: rec.parent, depth, prompt: rec.prompt.slice(0, 2000), startedAt: rec.startedAt, ...(schema !== undefined ? { schema } : {}) });
    }

    const where = worktree
      ? `\nYou work in your own git worktree at ${worktree.path}; your changes go back to ${opts.caller} as a patch when you finish.`
      : "\nOther agents and the user may be working in this folder at the same time.";
    const brief = `${opts.caller} started you as "${name}" (${opts.type.name}).${where}\n\n${opts.prompt}`;
    rec.status = "running";
    this.changed();
    void rec.session!.prompt(brief, { expandPromptTemplates: false }).catch((e: unknown) => this.fail(rec, e));
    return rec;
  }

  /** Builds the child's AgentSession with b4agent's extensions in child mode. */
  private async spawn(rec: AgentRecord, sessionManager: SessionManager, ctx: ExtensionContext) {
    const type = this.types.get(rec.type);
    const rootCtx = this.root.ctx() ?? ctx;
    const [provider, rest] = [rec.model.slice(0, rec.model.indexOf("/")), rec.model.slice(rec.model.indexOf("/") + 1)];
    const colon = rest.lastIndexOf(":");
    const [id, thinking] = colon > 0 ? [rest.slice(0, colon), rest.slice(colon + 1)] : [rest, undefined];
    const model = ctx.modelRegistry.getAll().find((m) => m.provider === provider && m.id === id) ?? ctx.model;
    if (!model) throw new Error(`model ${rec.model} is not available`);
    const settingsManager = SettingsManager.create(rec.cwd, this.agentDir, { projectTrusted: ctx.isProjectTrusted() });
    const loader = new DefaultResourceLoader({
      cwd: rec.cwd,
      agentDir: this.agentDir,
      settingsManager,
      extensionFactories: [{ name: "b4agent", factory: this.makeExtension({ child: { name: rec.name, hub: this } }) }],
      noPromptTemplates: true,
      noThemes: true,
    });
    await loader.reload();
    const runtime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
    const tools = type ? this.childTools(type, rec.depth) : undefined;
    const { session } = await createAgentSession({
      cwd: rec.cwd,
      agentDir: this.agentDir,
      ...(runtime ? { modelRuntime: runtime as never } : {}),
      model,
      ...(thinking ? { thinkingLevel: thinking as never } : {}),
      ...(tools ? { tools } : {}),
      resourceLoader: loader,
      sessionManager,
      settingsManager,
      sessionStartEvent: { type: "session_start", reason: rec.dormant ? "resume" : "startup" },
    });
    rec.session = session;
    rec.dormant = false;
    await session.bindExtensions({ uiContext: this.childUi(rec, rootCtx.ui), mode: "print", onError: () => undefined });
    session.subscribe((e) => this.onChildEvent(rec, e));
  }

  /** Children saved by an earlier run of this session come back dormant; they load when messaged. */
  restore(entries: readonly { type: string; customType?: string; data?: unknown }[]) {
    for (const e of entries) {
      if (e.type !== "custom") continue;
      const d = e.data as Record<string, unknown> | undefined;
      if (!d || typeof d.name !== "string") continue;
      if (e.customType === AGENT_ENTRY && typeof d.file === "string" && existsSync(d.file) && !this.agents.has(d.name)) {
        this.agents.set(d.name, {
          name: d.name,
          type: String(d.type),
          depth: Number(d.depth) || 1,
          parent: String(d.parent ?? MAIN),
          status: "idle",
          prompt: String(d.prompt ?? ""),
          model: String(d.model),
          cwd: String(d.cwd),
          file: d.file,
          dormant: true,
          startedAt: Number(d.startedAt) || Date.now(),
          endedAt: Number(d.startedAt) || Date.now(),
          reports: [],
          runs: 0,
          turns: 0,
          tokens: 0,
          cost: 0,
          reminders: 0,
          ...(d.schema !== undefined ? { schema: d.schema as OutputSchema } : {}),
        });
        const m = /^(.*)-(\d+)$/.exec(d.name);
        if (m) this.counters.set(m[1]!, Math.max(this.counters.get(m[1]!) ?? 0, Number(m[2])));
      }
      if (e.customType === AGENT_DONE_ENTRY) {
        const r = this.agents.get(d.name);
        if (r && typeof d.result === "string") {
          r.result = d.result;
          if (typeof d.endedAt === "number") r.endedAt = d.endedAt;
        }
      }
    }
    this.changed();
  }

  /** Loads a dormant child's conversation so it can take a message. */
  private async ensureSession(rec: AgentRecord): Promise<AgentSession> {
    if (rec.session) return rec.session;
    if (!rec.dormant || !rec.file) throw new Error(`${rec.name} has no conversation to continue`);
    const ctx = this.root.ctx();
    if (!ctx) throw new Error("the main session is not ready");
    await this.spawn(rec, SessionManager.open(rec.file, dirname(rec.file)), ctx);
    return rec.session!;
  }

  /** Fresh children are saved next to the main session (`<session>.agents/`); forks start from a copy of the caller's conversation. */
  private childSessionManager(rec: AgentRecord, forkFrom?: ExtensionContext): SessionManager {
    const rootFile = this.root.ctx()?.sessionManager.getSessionFile();
    const options = rootFile ? { parentSession: rootFile } : {};
    if (forkFrom) {
      const header = forkFrom.sessionManager.getHeader();
      const branch = forkFrom.sessionManager.getBranch();
      // Drop the assistant message that is calling `agent` right now: its tool call has no result yet.
      let cut = branch.length;
      for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i]!;
        if (e.type === "message" && e.message.role === "assistant") {
          cut = i;
          break;
        }
      }
      const entries = [...(header ? [{ ...header, cwd: rec.cwd }] : []), ...branch.slice(0, cut)] as FileEntry[];
      return SessionManager.inMemory(rec.cwd, options, entries);
    }
    if (!rootFile) return SessionManager.inMemory(rec.cwd, options);
    const dir = rootFile.replace(/\.jsonl$/, "") + ".agents";
    mkdirSync(dir, { recursive: true });
    return SessionManager.create(rec.cwd, dir, options);
  }

  /** The type's tools plus the child protocol tools. Undefined keeps Pi's defaults and every extension tool. */
  private childTools(type: AgentType, depth: number): string[] | undefined {
    if (!type.tools) return undefined;
    const own = ["submit", "report", "ask", "message", "agents", ...(depth < this.config.maxDepth ? ["agent"] : [])];
    return [...new Set([...type.tools, ...own])];
  }

  /**
   * A child's dialogs (permission asks) go to your terminal, labelled with
   * its name and marked in the panel; status, widgets and the editor stay
   * the main session's.
   */
  private childUi(rec: AgentRecord, ui: ExtensionUIContext): ExtensionUIContext {
    const label = (t: string) => `[${rec.name}] ${t}`;
    const flag = async <T>(fn: () => Promise<T>): Promise<T> => {
      rec.needsUser = true;
      this.changed();
      try {
        return await fn();
      } finally {
        rec.needsUser = false;
        this.changed();
      }
    };
    const noop = () => undefined;
    return {
      select: (t, o, opts) => flag(() => ui.select(label(t), o, opts)),
      confirm: (t, m, opts) => flag(() => ui.confirm(label(t), m, opts)),
      input: (t, p, opts) => flag(() => ui.input(label(t), p, opts)),
      editor: (t, p) => flag(() => ui.editor(label(t), p)),
      notify: (m, type) => ui.notify(label(m), type),
      custom: (factory, options) => flag(() => ui.custom(factory, options)),
      onTerminalInput: () => noop,
      setStatus: noop,
      setWorkingMessage: noop,
      setWorkingVisible: noop,
      setWorkingIndicator: noop,
      setHiddenThinkingLabel: noop,
      setWidget: noop,
      setFooter: noop,
      setHeader: noop,
      setTitle: noop,
      pasteToEditor: noop,
      setEditorText: noop,
      getEditorText: () => "",
      addAutocompleteProvider: noop,
      setEditorComponent: noop,
      getEditorComponent: () => undefined,
      get theme() {
        return ui.theme;
      },
      getAllThemes: () => ui.getAllThemes(),
      getTheme: (n) => ui.getTheme(n),
      setTheme: () => ({ success: false, error: "subagents can't change the theme" }),
      getToolsExpanded: () => false,
      setToolsExpanded: noop,
    } as ExtensionUIContext;
  }

  private onChildEvent(rec: AgentRecord, e: AgentSessionEvent) {
    switch (e.type) {
      case "agent_start":
        if (rec.status !== "stopped") rec.status = "running";
        rec.turns = 0;
        rec.submitted = undefined;
        rec.submittedData = undefined;
        rec.asked = undefined;
        rec.activity = "thinking";
        break;
      case "tool_execution_start":
        rec.activity = toolLabel(e.toolName, e.args as Record<string, unknown>);
        break;
      case "tool_execution_end":
        rec.activity = "thinking";
        break;
      case "message_end":
        if (e.message.role === "assistant") {
          const u = (e.message as { usage?: { totalTokens?: number; cost?: { total?: number } } }).usage;
          const m = e.message as { provider?: string; model?: string };
          logSideUsage(`subagent:${rec.type}`, `${m.provider}/${m.model}`, u as SideUsage | undefined);
          rec.tokens += u?.totalTokens ?? 0;
          rec.cost += u?.cost?.total ?? 0;
        }
        break;
      case "agent_settled":
        void this.finishRun(rec, e.aborted);
        return;
      case "queue_update":
        break;
      default:
        return;
    }
    this.changed();
  }

  private async finishRun(rec: AgentRecord, aborted: boolean) {
    rec.runs++;
    rec.activity = undefined;
    rec.endedAt = Date.now();
    if (rec.status === "stopped") {
      this.wake(rec.name);
      this.changed();
      return;
    }
    const last = rec.session?.getLastAssistantText()?.trim();
    const failed = rec.session?.messages.at(-1);
    const errorText = failed && failed.role === "assistant" && (failed as { stopReason?: string }).stopReason === "error" ? (failed as { errorMessage?: string }).errorMessage : undefined;
    if (rec.worktree) {
      try {
        const file = (this.root.ctx()?.sessionManager.getSessionFile()?.replace(/\.jsonl$/, ".agents") ?? join(this.b4agentDir, "tmp")) + `/${rec.name}.patch`;
        rec.patch = await capturePatch(rec.worktree, file);
      } catch (e) {
        rec.error = `could not capture the worktree changes: ${(e as Error).message}`;
      }
    }
    let text: string;
    if (rec.asked) {
      rec.status = "waiting";
      rec.result = undefined;
      text = `[${rec.name} asks ${rec.parent}] ${rec.asked}\nAnswer with message { to: "${rec.name}", text }.`;
    } else if (errorText && !rec.submitted) {
      rec.status = "failed";
      rec.error = errorText;
      text = `[${rec.name} failed] ${errorText}`;
    } else {
      rec.status = "idle";
      const structured = rec.submitted !== undefined && rec.submittedData !== undefined;
      rec.data = structured ? rec.submittedData : undefined;
      const missing = rec.schema !== undefined && !structured ? `\n\n(${rec.name} returned no data for the output schema${rec.reminders >= MAX_SUBMIT_REMINDERS ? ` after ${MAX_SUBMIT_REMINDERS} reminders` : ""}; this is its last message.)` : "";
      rec.result = (rec.submitted ?? last ?? "(no output)") + (structured ? `\n\ndata (JSON):\n\`\`\`json\n${JSON.stringify(rec.data, null, 2)}\n\`\`\`` : missing);
      const why = rec.overBudget ? " (stopped at its turn limit; this is what it had)" : aborted ? " (interrupted)" : "";
      text = `[${rec.name} finished${why}]\n${this.inline(rec)}${this.patchNote(rec)}`;
      if (rec.file && !rec.worktree) this.root.pi.appendEntry(AGENT_DONE_ENTRY, { name: rec.name, result: rec.result.slice(0, MAX_INLINE_RESULT * 4), endedAt: rec.endedAt });
    }
    rec.overBudget = false;
    rec.reminders = 0;
    rec.forceSubmit = false;
    this.changed();
    this.wake(rec.name);
    if (!rec.claimed) await this.deliver(rec.parent, text).catch(() => undefined);
  }

  /** The result as shown in a message: long ones are saved to a file with a preview. */
  inline(rec: AgentRecord): string {
    const r = rec.result ?? "";
    if (r.length <= MAX_INLINE_RESULT) return r;
    const base = this.root.ctx()?.sessionManager.getSessionFile()?.replace(/\.jsonl$/, ".agents") ?? join(this.b4agentDir, "tmp");
    const file = join(base, `${rec.name}-result-${rec.runs}.md`);
    try {
      mkdirSync(base, { recursive: true });
      writeFileSync(file, r);
    } catch {
      return r.slice(0, MAX_INLINE_RESULT) + "\n[… cut; the full result couldn't be saved]";
    }
    return `${r.slice(0, 2000)}\n\n[… ${r.length} characters in total; the full result is in ${file}]`;
  }

  /** Counts a child's turns against its type's budget: a warning 3 turns before, then a stop. */
  turnEnded(name: string) {
    const rec = this.agents.get(name);
    const max = rec && (this.config.agents[rec.type]?.maxTurns ?? this.types.get(rec.type)?.maxTurns);
    if (!rec || !max) return;
    rec.turns++;
    if (rec.turns === max - 3) {
      void rec.session?.sendCustomMessage({ customType: "b4agent-budget", content: `You have 3 turns left. Wrap up: call submit with what you have.`, display: true }, { deliverAs: "steer" });
    } else if (rec.turns >= max && rec.status === "running") {
      rec.overBudget = true;
      void rec.session?.abort();
    }
  }

  /**
   * At the end of a child's run (`agent_before_settle`): a child that owes
   * structured data and ended without submitting gets a reminder and one
   * more request, up to 3 times; the last one forces the submit tool
   * (oh-my-pi). Questions, stops, errors and the turn budget end the run as usual.
   * The reminder entry makes the context continuable; Pi checks that after
   * committing it (the event's own `canContinue` is from before).
   */
  submitReminder(name: string, outcome: string): CustomMessageEntryDraft | undefined {
    const rec = this.agents.get(name);
    if (!rec || rec.schema === undefined || rec.submitted !== undefined || rec.asked !== undefined) return undefined;
    if (outcome !== "completed" || rec.status === "stopped" || rec.overBudget || this.disposed) return undefined;
    if (rec.reminders >= MAX_SUBMIT_REMINDERS) return undefined;
    rec.reminders++;
    if (rec.reminders === MAX_SUBMIT_REMINDERS) rec.forceSubmit = true;
    this.changed();
    return { type: "custom_message", customType: "b4agent-submit-reminder", content: reminderText(rec.reminders), display: true };
  }

  /** `before_provider_request` in a child: the request after the last reminder may only call submit. */
  forcedPayload(name: string, payload: unknown): unknown {
    const rec = this.agents.get(name);
    if (!rec?.forceSubmit) return undefined;
    rec.forceSubmit = false;
    return forceToolChoice(payload, "submit");
  }

  patchNote(rec: AgentRecord): string {
    const p = rec.patch;
    if (!p) return rec.error && rec.worktree ? `\n\n${rec.error}` : "";
    if (!p.file) return "\n\nIts worktree has no changes.";
    if (p.applied) return `\n\nIts patch is applied to your checkout.`;
    return `\n\nChanges are in its worktree (${p.files.length} files), saved as ${p.file}:\n${p.stat}\nApply them to your checkout with agents { action: "apply", name: "${rec.name}" }.`;
  }

  private fail(rec: AgentRecord, e: unknown) {
    rec.status = "failed";
    rec.error = e instanceof Error ? e.message : String(e);
    rec.endedAt = Date.now();
    this.changed();
    this.wake(rec.name);
    if (rec.session && !rec.claimed) void this.deliver(rec.parent, `[${rec.name} failed] ${rec.error}`).catch(() => undefined);
  }

  private wake(name: string) {
    const set = this.waiters.get(name);
    if (!set) return;
    this.waiters.delete(name);
    for (const w of set) w();
  }

  /**
   * Waits until an agent stops working. Waiting claims its result, so it
   * isn't delivered a second time.
   */
  wait(name: string, signal?: AbortSignal, timeoutMs?: number): Promise<AgentRecord | undefined> {
    const rec = this.agents.get(name);
    if (!rec) return Promise.resolve(undefined);
    rec.claimed = true;
    if (rec.status !== "running" && rec.status !== "starting") return Promise.resolve(rec);
    return new Promise((done) => {
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        this.waiters.get(name)?.delete(finish);
        if (rec.status === "running" || rec.status === "starting") rec.claimed = false; // timed out: deliver as usual
        done(rec);
      };
      const timer = timeoutMs ? setTimeout(finish, timeoutMs) : undefined;
      signal?.addEventListener("abort", finish, { once: true });
      if (!this.waiters.has(name)) this.waiters.set(name, new Set());
      this.waiters.get(name)!.add(finish);
    });
  }

  private readonly foreground = new Set<{ owner: string; ctl: AbortController }>();

  /** A wait the user can cut short with Ctrl+B. */
  async foregroundWait(owner: string, name: string, signal?: AbortSignal): Promise<AgentRecord | undefined> {
    const entry = { owner, ctl: new AbortController() };
    const onAbort = () => entry.ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    this.foreground.add(entry);
    try {
      return await this.wait(name, entry.ctl.signal);
    } finally {
      this.foreground.delete(entry);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  hasForegroundWait(owner?: string): boolean {
    return [...this.foreground].some((f) => !owner || f.owner === owner);
  }

  releaseForeground(owner?: string): number {
    let n = 0;
    for (const f of [...this.foreground]) {
      if (owner && f.owner !== owner) continue;
      f.ctl.abort();
      n++;
    }
    return n;
  }

  /** Waits for the first of several agents to stop. */
  async waitAny(names: string[], signal?: AbortSignal, timeoutMs?: number): Promise<AgentRecord | undefined> {
    const done = names.map((n) => this.agents.get(n)).find((r) => r && r.status !== "running" && r.status !== "starting");
    if (done) {
      done.claimed = true;
      return done;
    }
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Only the winner keeps its claim; the others are released when the race ends.
      const winner = await Promise.race(names.map((n) => this.wait(n, ctl.signal, timeoutMs)));
      return winner;
    } finally {
      ctl.abort();
      signal?.removeEventListener("abort", onAbort);
      for (const n of names) {
        const r = this.agents.get(n);
        if (r && (r.status === "running" || r.status === "starting")) r.claimed = false;
      }
    }
  }

  async stop(name: string): Promise<boolean> {
    const rec = this.agents.get(name);
    if (!rec) return false;
    const was = rec.status;
    rec.status = "stopped";
    rec.endedAt = Date.now();
    this.changed();
    // Its own children stop with it.
    for (const c of this.agents.values()) if (c.parent === name && (c.status === "running" || c.status === "starting")) await this.stop(c.name);
    for (const j of this.jobs.values()) if (j.owner === name && j.status === "running") j.kill();
    if (was === "running" || was === "starting") await rec.session?.abort().catch(() => undefined);
    this.wake(name);
    return true;
  }

  async apply(name: string): Promise<string> {
    const rec = this.agents.get(name);
    if (!rec) return `No agent named "${name}".`;
    if (!rec.worktree) return `${name} worked in the shared checkout; its changes are already there.`;
    if (rec.status === "running" || rec.status === "starting") return `${name} is still running; wait for it to finish first.`;
    if (!rec.patch) rec.patch = await capturePatch(rec.worktree, join(dirname(rec.worktree.path), `${name}.patch`));
    if (!rec.patch.file) return `${name} changed nothing.`;
    if (rec.patch.applied) return `${name}'s patch is already applied.`;
    const r = await applyPatch(rec.worktree.root, rec.patch.file);
    if (!r.ok) return `The patch doesn't apply cleanly to the current files, so nothing was changed:\n${r.error}\nThe patch is at ${rec.patch.file}.`;
    rec.patch.applied = true;
    this.changed();
    return `Applied ${name}'s changes (${rec.patch.files.length} files):\n${rec.patch.stat}`;
  }

  // ---------------------------------------------------------------- bash jobs

  addJob(job: Omit<BashJob, "id">): BashJob {
    const j: BashJob = { ...job, id: `bash-${++this.jobCounter}` };
    this.jobs.set(j.id, j);
    this.changed();
    return j;
  }

  /** A killed job (stopped by you or an agent) ends quietly, like a cancelled one in the plan. */
  finishJob(job: BashJob, exitCode: number | null, tail: string, killed = false) {
    if (job.status !== "running") return;
    job.status = killed ? "killed" : exitCode === 0 ? "done" : "failed";
    job.exitCode = exitCode;
    job.endedAt = Date.now();
    this.changed();
    if (killed) return;
    const secs = Math.round((job.endedAt - job.startedAt) / 1000);
    const head = `[background job ${job.id} ${exitCode === 0 ? "finished" : exitCode === null ? "was killed" : `exited with code ${exitCode}`} after ${secs}s] ${job.command.split("\n")[0]!.slice(0, 120)}`;
    void this.deliver(job.owner, `${head}\nFull output: ${job.log}\n${tail ? `Last output:\n${tail}` : "(no output)"}`).catch(() => undefined);
  }

  // ---------------------------------------------------------------- shutdown

  /** Stops every child and job, captures worktree patches and removes the worktrees. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.outboxTimer) clearTimeout(this.outboxTimer);
    for (const j of this.jobs.values()) if (j.status === "running") j.kill();
    const recs = [...this.agents.values()];
    await Promise.allSettled(recs.map((r) => (r.status === "running" || r.status === "starting" ? r.session?.abort() : undefined)));
    for (const r of recs) {
      if (r.worktree) {
        if (!r.patch) {
          const file = join(dirname(r.worktree.path), `${r.name}.patch`);
          r.patch = await capturePatch(r.worktree, file).catch(() => undefined);
        }
        await removeWorktree(r.worktree).catch(() => undefined);
      }
      const runner = (r.session as unknown as { extensionRunner?: { hasHandlers(e: string): boolean; emit(e: unknown): Promise<unknown> } } | undefined)?.extensionRunner;
      if (runner?.hasHandlers("session_shutdown")) {
        await Promise.race([runner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined), new Promise((r) => setTimeout(r, 2000).unref())]);
      }
      try {
        r.session?.dispose();
      } catch {
        // already gone
      }
    }
    this.changed();
  }
}

function gitRoot(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function toolLabel(name: string, args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  const s = typeof a.command === "string" ? a.command : typeof a.path === "string" ? a.path : typeof a.pattern === "string" ? a.pattern : "";
  const one = s.split("\n")[0]!.slice(0, 60);
  return one ? `${name} ${one}` : name;
}

/** One hub per root session in this process; the checkpoint extension reads it to block rewinds while children work. */
let current: Hub | undefined;
export function currentHub(): Hub | undefined {
  return current;
}
export function setCurrentHub(h: Hub | undefined) {
  current = h;
}
