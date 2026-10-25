import { getAgentDir, ProjectTrustStore, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ChildHandle } from "../agents/hub.js";
import { resolveToolPath } from "../context/nested.js";
import { EVENTS, hookToolName, loadHooks, select, type CommandHook, type HookEvent, type Skipped } from "../hooks/config.js";
import { decide, hookLabel, reminder, type Decision } from "../hooks/decide.js";
import { DEFAULT_TIMEOUT_S, runAll, SESSION_END_TIMEOUT_S } from "../hooks/run.js";
import { memoryProjectRoot } from "../memory/store.js";
import { b4agentDir } from "../permissions/config.js";
import { setHookDecision } from "../permissions/hooks.js";
import type { PermissionShared } from "./permissions.js";

/** Claude Code's cap on consecutive Stop-hook continuations (CLAUDE_CODE_STOP_HOOK_BLOCK_CAP). */
const STOP_CAP = 8;
/** Claude Code fires `idle_prompt` about 60 s after a response when you haven't typed. */
const IDLE_MS = 60_000;
const CONTEXT_TYPE = "b4agent-hook";
const STATUS = "b4agent.hooks";
const FILE_TOOLS = new Set(["read", "write", "edit"]);

/**
 * Settings-defined shell hooks (plan section 28), in Claude Code's format so
 * existing hooks carry over. Pi events they map to:
 *   PreToolUse          tool_call (registered before the permission gate: a deny short-circuits it,
 *                       an allow or ask goes to the gate through src/permissions/hooks.ts)
 *   PostToolUse(Failure) tool_result
 *   UserPromptSubmit    input (block, context), delivered with before_agent_start
 *   Stop / SubagentStop agent_before_settle (a block appends the reason and continues)
 *   SessionStart        session_start and session_compact; SubagentStart in a child's session_start
 *   SessionEnd          session_shutdown
 *   PreCompact          session_before_compact (a block cancels)
 *   Notification        ui_prompt_start (permission_prompt, elicitation_dialog) and an idle timer (idle_prompt)
 * Subagents run the same hooks with agent_id and agent_type in the input.
 */
export default function hooks(pi: ExtensionAPI, opts: { child?: ChildHandle; shared?: PermissionShared } = {}) {
  const dir = b4agentDir();
  const child = opts.child;
  let all: CommandHook[] = [];
  let skipped: Skipped[] = [];
  let projectDir = process.cwd();
  let projectNote: string | undefined;
  let loaded = false;
  /** UserPromptSubmit context for the run the prompt starts. */
  let pending: string[] = [];
  let sessionStart: Promise<void> | undefined;
  let continuations = 0;
  let stopHookActive = false;
  const preContext = new Map<string, string[]>();
  const started = new Map<string, number>();
  let idle: NodeJS.Timeout | undefined;

  const agentType = () => (child ? child.hub.agents.get(child.name)?.type ?? child.name : undefined);

  function load(ctx: ExtensionContext) {
    projectDir = memoryProjectRoot(ctx.cwd);
    const trusted = ctx.isProjectTrusted() && explicitlyTrusted([ctx.cwd, projectDir]);
    const cfg = loadHooks(dir, projectDir, trusted);
    all = cfg.hooks;
    skipped = cfg.skipped;
    loaded = true;
    projectNote = cfg.projectHooksIgnored
      ? `Hooks in ${cfg.projectFile} are off: this project isn't trusted. Use /trust (then restart) or run with --approve to run them.`
      : undefined;
    if (child) return;
    for (const e of cfg.errors) ctx.ui.notify(`b4agent hooks: ${e}`, "warning");
    if (projectNote) ctx.ui.notify(projectNote, "warning");
  }

  function common(ctx: ExtensionContext, event: HookEvent): Record<string, unknown> {
    const shared = opts.shared;
    const mode = shared?.readOnly ? "plan" : shared?.mode === "manual" ? "default" : shared?.mode === "yolo" ? "bypassPermissions" : "auto";
    return {
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path: ctx.sessionManager.getSessionFile() ?? null,
      cwd: ctx.cwd,
      permission_mode: mode,
      hook_event_name: event,
      ...(child ? { agent_id: child.name, agent_type: agentType() } : {}),
    };
  }

  async function fire(
    ctx: ExtensionContext,
    event: HookEvent,
    value: string | undefined,
    fields: Record<string, unknown>,
    o: { tool?: { name: string; input: Record<string, unknown> }; timeoutS?: number; signal?: AbortSignal } = {},
  ): Promise<Decision | undefined> {
    if (!loaded) load(ctx);
    let chosen: CommandHook[];
    try {
      chosen = select(all, event, value, o.tool, ctx.cwd, projectDir);
    } catch (e) {
      // A hook problem is a non-blocking error, never Pi's "extension failed, blocking execution".
      ctx.ui.notify(`b4agent hooks: ${event}: ${(e as Error).message}`, "warning");
      return undefined;
    }
    if (!chosen.length) return undefined;
    const status = chosen.find((h) => h.statusMessage)?.statusMessage;
    if (status && !child) ctx.ui.setStatus(STATUS, status);
    try {
      const outcomes = await runAll(chosen, { ...common(ctx, event), ...fields }, {
        cwd: ctx.cwd,
        projectDir,
        ...(o.timeoutS !== undefined ? { timeoutS: o.timeoutS } : {}),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      const d = decide(event, outcomes, value ? `${event}:${o.tool ? hookToolName(value) : value}` : event);
      for (const n of d.notices) ctx.ui.notify(child ? `[${child.name}] ${n}` : n, "warning");
      return d;
    } finally {
      if (status && !child) ctx.ui.setStatus(STATUS, undefined);
    }
  }

  // --------------------------------------------------------------- sessions

  // SessionStart context goes into the conversation before the first prompt (Claude Code), as a
  // hidden message appended to the session; a message from before_agent_start would land after it.
  const deliver = (event: HookEvent) => (d: Decision | undefined) => {
    if (d?.contexts.length) pi.sendMessage({ customType: CONTEXT_TYPE, content: reminder(event, d.contexts), display: false });
  };

  pi.on("session_start", (event, ctx) => {
    load(ctx);
    pending = [];
    if (child) {
      sessionStart = fire(ctx, "SubagentStart", agentType(), {}).then(deliver("SubagentStart"));
      return;
    }
    // Claude Code runs SessionStart in the background and makes the first request wait for it.
    const source = event.reason === "new" ? "clear" : event.reason === "reload" ? "resume" : event.reason;
    sessionStart = fire(ctx, "SessionStart", source, { source, ...(ctx.model ? { model: ctx.model.id } : {}) }).then(deliver("SessionStart"));
  });

  pi.on("session_compact", (_event, ctx) => {
    if (child) return;
    // During a run, Pi holds the message until the turn ends.
    sessionStart = fire(ctx, "SessionStart", "compact", { source: "compact" }).then(deliver("SessionStart"));
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const trigger = event.reason === "manual" ? "manual" : "auto";
    const d = await fire(ctx, "PreCompact", trigger, { trigger, custom_instructions: event.customInstructions ?? null });
    if (d?.blocked === undefined) return;
    ctx.ui.notify(`Compaction blocked by a PreCompact hook: ${d.blocked}`, "warning");
    return { cancel: true };
  });

  if (!child) {
    pi.on("session_shutdown", async (event, ctx) => {
      if (idle) clearTimeout(idle);
      const reason = event.reason === "new" ? "clear" : event.reason === "resume" ? "resume" : event.reason === "quit" && ctx.hasUI ? "prompt_input_exit" : "other";
      await fire(ctx, "SessionEnd", reason, { reason }, { timeoutS: SESSION_END_TIMEOUT_S });
    });
  }

  /** The first prompt waits for SessionStart hooks; awaited from `input`, before the run starts, so their message lands first. */
  const sessionStarted = async () => {
    if (!sessionStart) return;
    await sessionStart;
    sessionStart = undefined;
  };

  pi.on("before_agent_start", async () => {
    // Runs started without `input` (a custom message with triggerTurn) wait here.
    await sessionStarted();
    if (!pending.length) return;
    const content = pending.join("\n\n");
    pending = [];
    return { message: { customType: CONTEXT_TYPE, content, display: false } };
  });

  // ---------------------------------------------------------------- prompts

  pi.on("input", async (event, ctx) => {
    continuations = 0;
    stopHookActive = false;
    await sessionStarted();
    // A subagent's prompts are its brief and deliveries, not the user's (Claude Code fires UserPromptSubmit in the main session only).
    if (child) return;
    if (idle) clearTimeout(idle);
    const d = await fire(ctx, "UserPromptSubmit", undefined, { prompt: event.text });
    if (!d) return;
    if (d.blocked !== undefined || d.stop !== undefined) {
      ctx.ui.notify(`Prompt blocked by a UserPromptSubmit hook: ${d.blocked ?? d.stop ?? ""}`.trim(), "warning");
      return { action: "handled" };
    }
    if (!d.contexts.length) return;
    const text = reminder("UserPromptSubmit", d.contexts);
    // A prompt typed while the agent works is queued; its context goes with it.
    if (event.streamingBehavior) pi.sendMessage({ customType: CONTEXT_TYPE, content: text, display: false }, { deliverAs: event.streamingBehavior });
    else pending.push(text);
    return;
  });

  // ------------------------------------------------------------------ tools

  pi.on("tool_call", async (event, ctx) => {
    continuations = 0;
    const name = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;
    const shown = toolInputFor(name, input, ctx.cwd);
    const d = await fire(ctx, "PreToolUse", name, { tool_name: hookToolName(name), tool_input: shown, tool_use_id: event.toolCallId }, {
      tool: { name, input },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!d) return;
    const label = `PreToolUse:${hookToolName(name)}`;
    if (d.stop !== undefined) {
      return { block: true, reason: `A ${label} hook stopped the agent${d.stop ? `: ${d.stop}` : "."}`, terminate: true };
    }
    if (d.permission === "deny") {
      const extra = d.contexts.length ? `\n\n${reminder("PreToolUse", d.contexts)}` : "";
      return { block: true, reason: `${label} hook [${d.hooks.map(hookLabel).join(", ")}] blocked this call: ${d.reason ?? "no reason given"}${extra}` };
    }
    if (d.contexts.length) preContext.set(event.toolCallId, d.contexts);
    if (d.updatedInput) applyUpdatedInput(input, d.updatedInput, shown, name);
    if (d.permission === "allow" || d.permission === "ask") {
      setHookDecision(event, {
        decision: d.permission,
        reason: d.reason ?? `[${d.hooks.map(hookLabel).join(", ")}]`,
        source: d.hooks.some((h) => h.source === "global") ? "global" : "project",
      });
    }
    return;
  });

  pi.on("tool_execution_start", (event) => {
    started.set(event.toolCallId, Date.now());
  });

  pi.on("tool_result", async (event, ctx) => {
    const id = event.toolCallId;
    const before = preContext.get(id);
    preContext.delete(id);
    const t0 = started.get(id);
    started.delete(id);
    const name = event.toolName;
    const hookName: HookEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
    const text = event.content.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
    const shown = toolInputFor(name, event.input, ctx.cwd);
    const fields: Record<string, unknown> = { tool_name: hookToolName(name), tool_input: shown, tool_use_id: id };
    if (event.isError) Object.assign(fields, { error: text, is_interrupt: Boolean(ctx.signal?.aborted) });
    else Object.assign(fields, { tool_response: toolResponseFor(name, text, shown, event.details), ...(t0 ? { duration_ms: Date.now() - t0 } : {}) });
    const d = await fire(ctx, hookName, name, fields, { tool: { name, input: event.input } });
    const add: string[] = [];
    if (before?.length) add.push(reminder("PreToolUse", before));
    if (d?.blocked !== undefined) add.push(`${hookName}:${hookToolName(name)} hook feedback:\n${d.blocked}`);
    if (d?.contexts.length) add.push(reminder(hookName, d.contexts));
    if (d?.stop !== undefined) {
      ctx.ui.notify(`A ${hookName} hook stopped the agent${d.stop ? `: ${d.stop}` : ""}`, "warning");
      ctx.abort();
    }
    if (!add.length) return;
    return { content: [...event.content, { type: "text" as const, text: `\n${add.join("\n\n")}` }] };
  });

  // -------------------------------------------------------------- stopping

  pi.on("agent_before_settle", async (event, ctx) => {
    // Claude Code: not after an interrupt (Esc) or an API error.
    if (event.outcome !== "completed") return;
    const hookName: HookEvent = child ? "SubagentStop" : "Stop";
    if (continuations >= STOP_CAP) {
      ctx.ui.notify(`${hookName} hooks kept the agent going ${STOP_CAP} times in a row; letting it stop.`, "warning");
      continuations = 0;
      return;
    }
    const fields: Record<string, unknown> = {
      stop_hook_active: stopHookActive,
      last_assistant_message: lastAssistantText(event.context.contextMessages as unknown[]),
      background_tasks: [],
      session_crons: [],
      ...(child ? { agent_transcript_path: ctx.sessionManager.getSessionFile() ?? null } : {}),
    };
    const d = await fire(ctx, hookName, agentType(), fields);
    if (!d) return;
    if (d.stop !== undefined) {
      if (d.stop) ctx.ui.notify(`${hookName} hook: ${d.stop}`, "info");
      return;
    }
    const feedback = d.blocked ?? (d.contexts.length ? d.contexts.join("\n\n") : undefined);
    if (feedback === undefined) return;
    continuations++;
    stopHookActive = true;
    return {
      entries: [...event.entries, { type: "custom_message" as const, customType: CONTEXT_TYPE, content: `${hookName} hook feedback:\n${feedback}`, display: true, details: { event: hookName } }],
      continue: true,
    };
  });

  // ---------------------------------------------------------- notification

  if (!child) {
    const notify = (ctx: ExtensionContext, type: string, message: string, title?: string) => {
      void fire(ctx, "Notification", type, { message, ...(title ? { title } : {}), notification_type: type });
    };
    pi.on("ui_prompt_start", (event, ctx) => {
      const title = event.title?.split("\n")[0];
      // The gate's dialog is "Allow <tool>?"; other blocking prompts (ask_user, /permissions) ask for input.
      if (title && /^Allow \S+\?$/.test(title)) notify(ctx, "permission_prompt", `b4agent needs your permission: ${title}`, "Permission needed");
      else notify(ctx, "elicitation_dialog", title ?? "b4agent needs your input", "Input needed");
    });
    pi.on("agent_start", () => {
      if (idle) clearTimeout(idle);
    });
    pi.on("agent_settled", (event, ctx) => {
      if (idle) clearTimeout(idle);
      if (event.aborted || !ctx.hasUI || !all.some((h) => h.event === "Notification")) return;
      idle = setTimeout(() => notify(ctx, "idle_prompt", "b4agent is waiting for your input"), IDLE_MS);
      idle.unref();
    });
  }

  // ------------------------------------------------------------------ /hooks

  if (!child) {
    pi.registerCommand("hooks", {
      description: "List the shell hooks loaded from ~/.b4agent/b4agent.json and the project's .pi/b4agent.json",
      handler: async (_args, ctx) => {
        load(ctx);
        ctx.ui.notify(describe(all, skipped, projectNote), "info");
      },
    });
  }
}

/** Project hooks need a trust decision the user made (Pi's /trust or --approve), not Pi's implicit trust of a folder without .pi/settings.json. */
function explicitlyTrusted(dirs: string[]): boolean {
  if (process.argv.slice(2).some((a) => a === "--approve" || a === "-a")) return true;
  try {
    const store = new ProjectTrustStore(getAgentDir());
    return dirs.some((d) => store.get(d) === true);
  } catch {
    return false;
  }
}

export function describe(hooks: readonly CommandHook[], skipped: readonly Skipped[], note?: string): string {
  const lines: string[] = [];
  for (const event of EVENTS) {
    const hs = hooks.filter((h) => h.event === event);
    if (!hs.length) continue;
    lines.push(`${event}`);
    for (const h of hs) {
      const extra = [h.if && `if ${h.if}`, `timeout ${h.timeout ?? (event === "SessionEnd" ? SESSION_END_TIMEOUT_S : DEFAULT_TIMEOUT_S)}s`, h.onFailure === "block" && "onFailure block"].filter(Boolean).join(", ");
      lines.push(`  [${h.source}] ${h.matcher || "*"} → ${hookLabel(h)} (${extra})`);
    }
  }
  if (!lines.length) lines.push("No hooks loaded. Add a \"hooks\" object (Claude Code's format) to ~/.b4agent/b4agent.json or the project's .pi/b4agent.json.");
  if (skipped.length) {
    lines.push("", "Skipped:");
    for (const s of skipped) lines.push(`  [${s.source}] ${s.what}: ${s.why}`);
  }
  if (note) lines.push("", note);
  return lines.join("\n");
}

/** Pi's input plus Claude Code's field names, so hooks written for Claude Code read what they expect. */
export function toolInputFor(tool: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  if (FILE_TOOLS.has(tool) && typeof input.path === "string") out.file_path = resolveToolPath(input.path, cwd, process.env.HOME);
  if (tool === "edit" && Array.isArray(input.edits) && input.edits.length === 1) {
    const e = input.edits[0] as { oldText?: unknown; newText?: unknown };
    out.old_string = e.oldText;
    out.new_string = e.newText;
    out.replace_all = false;
  }
  if (tool === "grep" && input.ignoreCase !== undefined) out["-i"] = input.ignoreCase;
  return out;
}

/** Applies `updatedInput` in place: changed Claude Code aliases map back to Pi's fields, unchanged ones are dropped. */
export function applyUpdatedInput(target: Record<string, unknown>, updated: Record<string, unknown>, shown: Record<string, unknown>, tool: string): void {
  const next: Record<string, unknown> = { ...updated };
  // An alias wins when the hook changed it, or when it sent only Claude Code's shape.
  const use = (alias: string, field: string) => alias in next && (!(field in next) || JSON.stringify(next[alias]) !== JSON.stringify(shown[alias]));
  if (FILE_TOOLS.has(tool) && use("file_path", "path") && typeof next.file_path === "string") next.path = next.file_path;
  if (tool === "edit" && (use("old_string", "edits") || use("new_string", "edits"))) next.edits = [{ oldText: next.old_string, newText: next.new_string }];
  if (tool === "grep" && use("-i", "ignoreCase")) next.ignoreCase = next["-i"];
  for (const k of ["file_path", "old_string", "new_string", "replace_all", "-i"]) if (!(k in target)) delete next[k];
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, next);
}

function toolResponseFor(tool: string, text: string, shown: Record<string, unknown>, details: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { output: text };
  if (tool === "bash") Object.assign(out, { stdout: text, stderr: "", interrupted: false, isImage: false });
  if (typeof shown.file_path === "string") out.filePath = shown.file_path;
  if (details && typeof details === "object") {
    try {
      out.details = JSON.parse(JSON.stringify(details)) as unknown;
    } catch {
      // not serializable; leave it out
    }
  }
  return out;
}

function lastAssistantText(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role !== "assistant") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) return m.content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join("");
    return null;
  }
  return null;
}
