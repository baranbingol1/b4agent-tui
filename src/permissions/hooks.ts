import type { Verdict } from "./types.js";

/**
 * How a PreToolUse hook's allow or ask reaches the gate (src/hooks/,
 * src/extension/hooks.ts). The hooks handler runs before the gate and puts
 * its decision on the `tool_call` event object, which Pi passes to every
 * handler; a hook deny never gets here, it blocks the call itself.
 *
 * Ordering, after Claude Code ("hook allow doesn't override deny or ask
 * rules"; https://code.claude.com/docs/en/hooks#pretooluse-decision-control):
 * - ask: the call goes to the user in auto and manual mode, even when the
 *   rules or the reviewer would have allowed it. It can't lift a deny. YOLO
 *   runs it, as YOLO runs every ask; a hook that must hold in YOLO denies.
 * - allow: skips the reviewer (auto) or the prompt (manual) for calls the
 *   rules send there (`review`, `auto`). Never past a hard deny or an
 *   always-ask rule (protected paths, credentials, publishing, force push),
 *   never out of spec mode, and only from global hooks: a repository can't
 *   add allow rules (plan sections 0 and 1).
 */
export interface HookDecision {
  decision: "allow" | "ask";
  reason: string;
  source: "global" | "project";
}

const KEY = Symbol.for("b4agent.hookDecision");

export function setHookDecision(event: object, d: HookDecision): void {
  (event as Record<symbol, unknown>)[KEY] = d;
}

export function hookDecisionOf(event: object): HookDecision | undefined {
  return (event as Record<symbol, HookDecision | undefined>)[KEY];
}

export function applyHookDecision(v: Verdict, d: HookDecision | undefined): Verdict {
  if (!d || v.level === "deny") return v;
  const keep = v.targets ? { targets: v.targets } : {};
  if (d.decision === "ask") {
    if (v.level === "ask") return { ...v, reason: `${v.reason}; a hook also asks: ${d.reason}` };
    return { level: "ask", rule: "hook-ask", reason: `a PreToolUse hook asks for confirmation: ${d.reason}`, ...keep };
  }
  if (d.source !== "global") return v;
  if (v.level === "review" || v.level === "auto") return { level: "allow", rule: "hook-allow", reason: `allowed by a PreToolUse hook: ${d.reason}`, ...keep };
  return v;
}
