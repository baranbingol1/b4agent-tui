import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadB4Config } from "../config.js";
import { type ChildHandle, currentHub, type ExtensionMaker, Hub, MAIN, setCurrentHub } from "../agents/hub.js";
import { AgentPanel, elapsed } from "../agents/panel.js";
import { registerStaleGuard } from "../agents/stale.js";
import { registerAgentTools, registerChildTools } from "../agents/tools.js";
import { registerAgentCreate } from "../agents/create.js";
import { type OutputSchema, schemaBlock } from "../agents/schema.js";
import { isReadOnly, loadAgentTypes, type AgentType } from "../agents/types.js";
import { backgroundForeground, hasForeground, registerBash } from "../jobs/bash.js";
import { gitInfo } from "../permissions/git.js";
import { b4agentDir } from "../permissions/config.js";
import { b4agentIdentity, setPreamble } from "../prompt.js";
import { installTabRouting } from "../keys.js";
import { existsSync, readFileSync } from "node:fs";

/**
 * Subagents and background jobs (plan sections 2, 11, 21). In the main
 * session this owns the hub, the agent panel and Ctrl+B; inside a child it
 * adds the child protocol tools and the child's own system prompt.
 */
export default function agents(pi: ExtensionAPI, opts: { child?: ChildHandle; makeExtension: ExtensionMaker }) {
  registerStaleGuard(pi);
  if (opts.child) return child(pi, opts.child);

  const dir = b4agentDir();
  let config = loadB4Config(dir);
  let hub: Hub | undefined;
  let panel: AgentPanel | undefined;
  let ctxRef: ExtensionContext | undefined;
  let offTabs: (() => void) | undefined;
  const logDir = (ctx: ExtensionContext) => (ctx.sessionManager.getSessionFile()?.replace(/\.jsonl$/, ".agents") ?? join(dir, "tmp")) + "/jobs";

  registerAgentTools(pi, () => hub, MAIN, { canSpawn: () => true });
  registerBash(pi, { hub: () => hub, owner: MAIN, autoBackgroundSeconds: config.jobs.autoBackgroundSeconds, logDir });

  const projectRoot = (ctx: ExtensionContext) => gitInfo(ctx.cwd).root ?? ctx.cwd;
  const readTypes = (ctx: ExtensionContext, errors: string[]) =>
    loadAgentTypes({ b4agentDir: dir, projectRoot: projectRoot(ctx), projectTrusted: ctx.isProjectTrusted(), overrides: config.agents, errors });
  // Main session only: children can't create types, and the user confirms every file.
  registerAgentCreate(pi, {
    b4agentDir: dir,
    projectRoot,
    types: () => hub?.types,
    roles: () => config.roles,
    reload: (ctx) => {
      if (!hub) return undefined;
      const errors: string[] = [];
      hub.replaceTypes(readTypes(ctx, errors));
      for (const e of errors) ctx.ui.notify(`b4agent: ${e}`, "warning");
      return hub.types;
    },
  });

  // The agents section changes only with the type set, so the prompt cache breaks once per new type, not per run.
  let section: { hub: Hub; version: number; text: string } | undefined;

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    panel?.detach(ctx.ui);
    await hub?.dispose();
    const errors: string[] = [];
    config = loadB4Config(dir, errors);
    const types = readTypes(ctx, errors);
    for (const e of errors) ctx.ui.notify(`b4agent: ${e}`, "warning");
    hub = new Hub({ pi, ctx: () => ctxRef }, config, types, dir, getAgentDir(), opts.makeExtension);
    setCurrentHub(hub);
    hub.restore(ctx.sessionManager.getEntries() as never);
    if (ctx.hasUI && ctx.mode === "tui") {
      panel = new AgentPanel(hub, () => ctxRef, () => {
        // Ctrl+B is the editor's cursor-left key; it only backgrounds while something is in the foreground.
        if (!hasForeground(MAIN) && !hub?.hasForegroundWait(MAIN)) return false;
        const n = backgroundForeground(MAIN) + (hub?.releaseForeground(MAIN) ?? 0);
        if (n) ctxRef?.ui.notify(`Moved ${n === 1 ? "it" : `${n} tasks`} to the background; you'll get a message when ${n === 1 ? "it ends" : "they end"}.`, "info");
        return n > 0;
      });
      panel.attach(ctx.ui);
      offTabs?.();
      offTabs = tabMovedToShiftRight() ? installTabRouting(ctx.ui) : undefined;
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    panel?.detach(ctx.ui);
    panel = undefined;
    const h = hub;
    hub = undefined;
    if (currentHub() === h) setCurrentHub(undefined);
    await h?.dispose();
  });

  pi.on("before_agent_start", (event, ctx) => {
    ctxRef = ctx;
    const o = event.systemPromptOptions;
    setPreamble(o, config.prompt ?? b4agentIdentity());
    // No agents section when the agent tool is turned off (--exclude-tools agent, --tools without it).
    if (hub && o.selectedTools.includes("agent")) {
      if (section?.hub !== hub || section.version !== hub.typesVersion) section = { hub, version: hub.typesVersion, text: mainSection(hub.types) };
      o.sections.agents = section.text;
    }
  });

  pi.registerCommand("agents", {
    description: "Subagents in this session: open one's transcript to watch or message it",
    handler: async (_args, ctx) => {
      if (!hub?.agents.size) {
        ctx.ui.notify("No subagents in this session yet.", "info");
        return;
      }
      const recs = [...hub.agents.values()];
      const labels = recs.map((a) => `${a.name} · ${a.type} · ${a.needsUser ? "needs you" : a.dormant ? "earlier run" : a.status === "idle" ? "done" : a.status} · ${elapsed(a.startedAt, a.status === "running" ? undefined : a.endedAt)}`);
      const pick = await ctx.ui.select("Open which agent?", labels);
      const rec = pick ? recs[labels.indexOf(pick)] : undefined;
      if (rec) await panel?.open(rec.name);
    },
  });

  pi.registerCommand("jobs", {
    description: "Background bash jobs in this session, finished ones included",
    handler: async (_args, ctx) => {
      const jobs = [...(hub?.jobs.values() ?? [])];
      if (!jobs.length) {
        ctx.ui.notify("No background jobs in this session.", "info");
        return;
      }
      const lines = jobs.map((j) => `${j.id}  ${j.status === "running" ? "running" : j.status === "done" ? "done" : j.status === "killed" ? "stopped" : `exit ${j.exitCode}`}  ${elapsed(j.startedAt, j.endedAt)}  ${j.command.split("\n")[0]!.slice(0, 60)}\n    ${j.log}`);
      const running = jobs.filter((j) => j.status === "running");
      if (!running.length) {
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      const pick = await ctx.ui.select(`${lines.join("\n")}\n\nStop a running job?`, [...running.map((j) => `Stop ${j.id}`), "Close"]);
      const job = running.find((j) => pick === `Stop ${j.id}`);
      if (job) job.kill();
    },
  });
}

function child(pi: ExtensionAPI, handle: ChildHandle) {
  const { hub, name } = handle;
  const rec = () => hub.agents.get(name);
  const depth = rec()?.depth ?? 1;
  const logDir = (ctx: ExtensionContext) => (hub.root.ctx()?.sessionManager.getSessionFile()?.replace(/\.jsonl$/, ".agents") ?? join(hub.b4agentDir, "tmp")) + "/jobs";
  registerAgentTools(pi, () => hub, name, { canSpawn: () => depth < hub.config.maxDepth });
  registerChildTools(pi, hub, name);
  registerBash(pi, { hub: () => hub, owner: name, autoBackgroundSeconds: hub.config.jobs.autoBackgroundSeconds, logDir: (ctx) => logDir(ctx) });

  pi.on("before_agent_start", (event) => {
    const r = rec();
    const type = r ? hub.types.get(r.type) : undefined;
    const o = event.systemPromptOptions;
    setPreamble(o, type?.prompt || b4agentIdentity());
    if (r) o.sections.agents = childSection(r.name, r.type, r.parent, Boolean(r.worktree), depth < hub.config.maxDepth ? hub.types : undefined, r.schema);
  });

  pi.on("turn_end", () => hub.turnEnded(name));
  // Structured output: remind a child that ended without submitting, and force submit on the last reminder.
  pi.on("agent_before_settle", (event) => {
    const reminder = hub.submitReminder(name, event.outcome);
    return reminder ? { entries: [...event.entries, reminder], continue: true } : undefined;
  });
  pi.on("before_provider_request", (event) => hub.forcedPayload(name, event.payload));
}

/** Tab routing only makes sense with the launcher's keybindings (Pi's Tab action on Shift+Right). */
function tabMovedToShiftRight(): boolean {
  const file = join(getAgentDir(), "keybindings.json");
  if (!existsSync(file)) return false;
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>)["tui.input.tab"];
    return v === "shift+right" || (Array.isArray(v) && v.length === 1 && v[0] === "shift+right");
  } catch {
    return false;
  }
}

function typeList(types: Map<string, AgentType>): string {
  return [...types.values()]
    .map((t) => `- ${t.name}${isReadOnly(t) ? " (read-only)" : ""}${t.isolation === "worktree" ? " (own worktree)" : ""}${t.locked ? " (fixed model)" : ""}${t.output !== undefined ? " (structured output)" : ""}: ${t.description}`)
    .join("\n");
}

/** Stable text, so the prompt cache survives: the live roster comes from `agents list`. */
export function mainSection(types: Map<string, AgentType>): string {
  return `You can start read-only helper subagents with the agent tool. Do the work yourself in this context, including reading code, analysis and checking your own work. Use a helper only to keep bulky lookups out of this context:
- search: a broad codebase search whose raw output you don't need, only the file-referenced findings;
- librarian: research on libraries, frameworks or APIs outside this repository;
- historian: what earlier sessions decided or tried.
Don't use them for second opinions on code you are already reading. Run independent lookups in parallel; each result arrives as a message, so keep working and call agents wait only when nothing else is left.${types.has("reviewer") ? `
- Start a reviewer (security-reviewer for a security review) only when the user asks for a review: give it the target (uncommitted changes, a branch against its base, a commit or a PR), any focus the user gave and any spec files the work follows. Relay its findings as written (P0-P3), most severe first; if it says LGTM, reply exactly LGTM.` : ""}

Types:
${typeList(types)}`;
}

export function childSection(name: string, type: string, parent: string, worktree: boolean, spawnable: Map<string, AgentType> | undefined, schema?: OutputSchema): string {
  const lines = [
    `You are "${name}", a ${type} subagent started by ${parent}. ${parent} hasn't seen your work: finish with submit (or a final message) that is self-contained and says what you did, what you found and what's left.`,
    `- report sends ${parent} a short progress note without stopping; use it only for milestones they'd act on.`,
    `- ask sends ${parent} a question only they can answer and pauses you until the reply arrives. Don't ask what you can find out yourself.`,
    "- message reaches any agent in this session by name; agents list shows who is here.",
    worktree
      ? `- You work in your own git worktree. Your changes go back to ${parent} as a patch when you finish; don't commit.`
      : "- Other agents and the user may be working in this folder at the same time, so files can change under you. Never revert or reformat changes you didn't make. If an edit fails because the file changed, read it again and redo your change on the current content.",
  ];
  if (schema !== undefined) lines.push("", `${parent} asked for structured output. Finish with submit { result, data }: result is a short summary, and data must match this JSON Schema (a mismatch comes back as an error to fix):`, schemaBlock(schema));
  if (spawnable) lines.push("", "You can start your own subagents with agent. Types:", typeList(spawnable));
  return lines.join("\n");
}
