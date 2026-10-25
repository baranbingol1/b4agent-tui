import type { CommandHook, HookEvent } from "./config.js";
import type { Outcome } from "./run.js";

/**
 * What a set of hook results means for one event, after Claude Code's
 * decision-control rules (https://code.claude.com/docs/en/hooks#decision-control).
 */
export interface Decision {
  /** PreToolUse: deny > ask > allow (`defer` is ignored outside Claude Code's -p mode). */
  permission?: "allow" | "ask" | "deny";
  /** Reasons of the hooks that gave the winning permission, or of a block. */
  reason?: string;
  /** PreToolUse `updatedInput` from an allow or ask hook. */
  updatedInput?: Record<string, unknown>;
  /** Exit 2 or `decision: "block"` on events that can block (PreToolUse uses `permission`). */
  blocked?: string;
  /** `additionalContext`, and plain stdout where Claude Code adds it as context. */
  contexts: string[];
  /** `continue: false`: stop the agent; the value is `stopReason`. */
  stop?: string;
  /** For the user: `systemMessage`s and hook errors. */
  notices: string[];
  /** Which hooks gave the winning permission or block. */
  hooks: CommandHook[];
}

/** Events whose plain stdout becomes context (Claude Code: UserPromptSubmit and SessionStart; Codex adds SubagentStart). */
const TEXT_IS_CONTEXT = new Set<HookEvent>(["UserPromptSubmit", "SessionStart", "SubagentStart"]);
/** Events that discard `continue` and `systemMessage`. */
const NO_CONTROL = new Set<HookEvent>(["Notification", "SessionEnd", "PreCompact"]);
/** Events where exit 2 or `decision: "block"` means something. */
const CAN_BLOCK = new Set<HookEvent>(["UserPromptSubmit", "PostToolUse", "PostToolUseFailure", "Stop", "SubagentStop", "PreCompact"]);

const RANK = { allow: 1, ask: 2, deny: 3 } as const;

const specific = (json: Record<string, unknown> | undefined): Record<string, unknown> => {
  const h = json?.hookSpecificOutput;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : {};
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function hookLabel(h: CommandHook): string {
  return h.args?.length ? `${h.command} ${h.args.join(" ")}` : h.command;
}

export function decide(event: HookEvent, outcomes: readonly Outcome[], label: string = event): Decision {
  const d: Decision = { contexts: [], notices: [], hooks: [] };
  const perms: { level: "allow" | "ask" | "deny"; reason?: string; o: Outcome; updatedInput?: Record<string, unknown> }[] = [];
  const blocks: { reason: string; o: Outcome }[] = [];
  for (const o of outcomes) {
    if (o.error) d.notices.push(`${label} hook error: [${hookLabel(o.hook)}]: ${o.error}`);
    const json = o.json;
    const hso = specific(json);
    const context = str(hso.additionalContext);
    if (context) d.contexts.push(context);
    if (o.text && TEXT_IS_CONTEXT.has(event) && !o.blocking) d.contexts.push(o.text);
    if (json && !NO_CONTROL.has(event)) {
      if (json.continue === false) d.stop = typeof json.stopReason === "string" ? json.stopReason : d.stop ?? "";
      const sys = str(json.systemMessage);
      if (sys) d.notices.push(sys);
    }

    if (event === "PreToolUse") {
      const legacy = json?.decision === "approve" ? "allow" : json?.decision === "block" ? "deny" : undefined;
      const raw = o.blocking ? "deny" : (hso.permissionDecision as string | undefined) ?? legacy;
      if (raw === "defer") d.notices.push(`${label} hook [${hookLabel(o.hook)}] returned "defer", which b4agent ignores`);
      if (raw === "allow" || raw === "ask" || raw === "deny") {
        const reason = o.blocking ? o.blockReason : str(hso.permissionDecisionReason) ?? str(json?.reason);
        const updated = hso.updatedInput && typeof hso.updatedInput === "object" && !Array.isArray(hso.updatedInput) ? (hso.updatedInput as Record<string, unknown>) : undefined;
        perms.push({ level: raw, ...(reason ? { reason } : {}), o, ...(updated && raw !== "deny" ? { updatedInput: updated } : {}) });
      }
      continue;
    }

    if (CAN_BLOCK.has(event)) {
      // A JSON block decision's reason wins over stderr (Claude Code, "Exit code 2").
      const jsonBlock = json?.decision === "block" ? str(json.reason) ?? "(no reason given)" : undefined;
      if (jsonBlock !== undefined) blocks.push({ reason: jsonBlock, o });
      else if (o.blocking) blocks.push({ reason: o.blockReason ?? "", o });
    } else if (o.blocking && o.blockReason && event !== "Notification") {
      // SessionStart, SessionEnd, SubagentStart: Claude Code shows exit-2 stderr to the user only. Notification ignores it.
      d.notices.push(`${label} hook [${hookLabel(o.hook)}]: ${o.blockReason}`);
    }
  }

  if (perms.length) {
    const top = perms.reduce((a, b) => (RANK[b.level] > RANK[a.level] ? b : a)).level;
    const winners = perms.filter((p) => p.level === top);
    d.permission = top;
    const reasons = winners.map((p) => p.reason).filter((r): r is string => Boolean(r));
    if (reasons.length) d.reason = reasons.join("\n");
    const upd = winners.find((p) => p.updatedInput)?.updatedInput;
    if (upd) d.updatedInput = upd;
    d.hooks = winners.map((p) => p.o.hook);
  }
  if (blocks.length) {
    d.blocked = blocks.map((b) => b.reason).join("\n");
    d.hooks = blocks.map((b) => b.o.hook);
  }
  return d;
}

/** Hook text for the model, wrapped the way Claude Code delivers it (a system reminder; nested tags defused). */
export function reminder(event: HookEvent, texts: readonly string[]): string {
  const body = texts.map((t) => t.replace(/<(\/?system-reminder)/g, "&lt;$1")).join("\n\n");
  return `<system-reminder>\n${event} hook additional context:\n${body}\n</system-reminder>`;
}
