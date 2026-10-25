import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { b4agentDir, loadConfig, type PermissionConfig } from "../permissions/config.js";
import { grantFor, MODES, route, type Mode } from "../permissions/gate.js";
import { gitInfo, realpathPrefix, unrecoverableIn } from "../permissions/git.js";
import { isInside } from "../permissions/paths.js";
import { checkpointStatus } from "../checkpoints/store.js";
import { createLog } from "../permissions/log.js";
import { buildReviewInput, redact, truncateMiddle, type UserMessage } from "../permissions/review/input.js";
import { createReviewer, type Reviewer, type ReviewModels, type ReviewResult } from "../permissions/review/reviewer.js";
import { classifyToolCall } from "../permissions/rules/tools.js";
import { applyHookDecision, hookDecisionOf } from "../permissions/hooks.js";
import type { PermissionContext, Verdict } from "../permissions/types.js";
import { serializeDialog } from "../dialogs.js";
import { seenUrls } from "../web/provenance.js";

/**
 * State the main session shares with its subagents: they follow its mode
 * and session grants, and their reviewer judges against the user's own
 * messages (a child's brief is written by an agent, not the user).
 */
export interface PermissionShared {
  mode: Mode;
  grants: Map<string, string>;
  userMessages: () => UserMessage[];
  /** Saves a session grant in the main session, so it survives a resume. */
  saveGrant: (key: string, label: string) => void;
  /** Switches the main session's mode (spec mode's "proceed with auto mode"). */
  setMode: (mode: Mode) => void;
  /** Set while spec mode is on: only calls the rules allow outright run, in every agent. */
  readOnly?: { reason: string };
  /** The rules' verdict for a call in the main session, for side channels that run their own tools (`/btw`). */
  classify: (tool: string, input: Record<string, unknown>, ctx: ExtensionContext) => Verdict;
}

export function createPermissionShared(): PermissionShared {
  return {
    mode: "auto", grants: new Map(), userMessages: () => [], saveGrant: () => undefined, setMode: () => undefined,
    classify: () => ({ level: "ask", rule: "not-ready", reason: "the permission gate hasn't started" }),
  };
}

const MODE_ENTRY = "b4agent-permissions-mode";
const GRANT_ENTRY = "b4agent-permissions-grant";
const STATUS = "b4agent.permissions";

const YES = "Yes";
const NO = "No";
const NO_WITH_NOTE = "No, and tell the agent what to do instead";

/**
 * The permission gate (plan section 1): rules, then the reviewer in auto
 * mode, then the user. Every tool call, including nested codemode calls,
 * passes through `tool_call`.
 */
export default function permissions(pi: ExtensionAPI, opts: { shared?: PermissionShared; child?: boolean } = {}) {
  const shared = opts.shared ?? createPermissionShared();
  const child = Boolean(opts.child);
  const dir = b4agentDir();
  const log = createLog(join(dir, "permissions.log"));
  const home = process.env.HOME ?? homedir();

  let config: PermissionConfig;
  let workspace = process.cwd();
  let inGit = false;
  let reviewer: Reviewer | undefined;
  const grants = shared.grants;

  if (!child) {
    pi.registerFlag("yolo", { type: "boolean", description: "Start in YOLO mode: run everything except hard denies" });
    pi.registerFlag("permissions", { type: "string", description: "Permission mode: auto, manual or yolo" });
  }

  const setStatus = (ctx: ExtensionContext) => ctx.ui.setStatus(STATUS, shared.mode === "auto" ? "auto mode" : shared.mode === "manual" ? "manual mode" : "YOLO mode");

  pi.on("session_start", async (_event, ctx) => {
    const errors: string[] = [];
    const git = gitInfo(ctx.cwd);
    workspace = git.root ?? ctx.cwd;
    inGit = Boolean(git.root);
    config = loadConfig(dir, git.root ?? ctx.cwd, errors);
    reviewer = config.reviewer === "off" ? undefined : createReviewer(ctx.modelRegistry as unknown as ReviewModels, {
      jev: config.reviewer === "auto" || config.reviewer === "jev",
      llm: config.reviewer === "jev" ? undefined : config.reviewerModel,
    });
    if (child) return;
    for (const e of errors) ctx.ui.notify(`b4agent permissions: ${e}`, "warning");
    shared.userMessages = () => userMessages(ctx);
    shared.classify = (tool, input, c) => classifyToolCall(tool, input, permissionContext(c, tool));
    shared.saveGrant = (key, label) => pi.appendEntry(GRANT_ENTRY, { key, label });
    shared.setMode = (m) => {
      shared.mode = m;
      pi.appendEntry(MODE_ENTRY, { mode: m });
      log({ event: "mode", mode: m, session: ctx.sessionManager.getSessionId() });
      setStatus(ctx);
    };

    grants.clear();
    let restored: Mode | undefined;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type !== "custom") continue;
      const data = e.data as { mode?: unknown; key?: unknown; label?: unknown } | undefined;
      if (e.customType === MODE_ENTRY && MODES.includes(data?.mode as Mode)) restored = data!.mode as Mode;
      if (e.customType === GRANT_ENTRY && typeof data?.key === "string") grants.set(data.key, String(data.label ?? data.key));
    }
    const flag = pi.getFlag("yolo") === true ? "yolo" : pi.getFlag("permissions");
    if (typeof flag === "string" && !MODES.includes(flag as Mode)) ctx.ui.notify(`--permissions must be one of ${MODES.join(", ")}`, "error");
    shared.mode = MODES.includes(flag as Mode) ? (flag as Mode) : restored ?? config.mode;
    setStatus(ctx);
  });

  if (!child) pi.registerCommand("permissions", {
    description: "Show or switch the permission mode (auto, manual, yolo)",
    getArgumentCompletions: (prefix) => MODES.filter((m) => m.startsWith(prefix)).map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      let next = args.trim() as Mode | "";
      if (!next) {
        const describe = {
          auto: "auto: rules, then the reviewer; asks only for risky actions you didn't request",
          manual: "manual: asks before anything that isn't read-only",
          yolo: "yolo: runs everything except hard denies",
        };
        const pick = await ctx.ui.select(`Permission mode (now ${shared.mode}). Reviewer: ${reviewer?.describe() ?? "off"}`, MODES.map((m) => describe[m]));
        if (!pick) return;
        next = pick.split(":")[0] as Mode;
      }
      if (!MODES.includes(next as Mode)) {
        ctx.ui.notify(`Unknown mode "${next}". Use ${MODES.join(", ")}.`, "error");
        return;
      }
      shared.mode = next as Mode;
      pi.appendEntry(MODE_ENTRY, { mode: shared.mode });
      log({ event: "mode", mode: shared.mode, session: ctx.sessionManager.getSessionId() });
      setStatus(ctx);
      ctx.ui.notify(`Permission mode: ${shared.mode}`, "info");
    },
  });

  // Shift+Tab is spec mode (plan section 13), so the permission mode gets its own key.
  if (!child) pi.registerShortcut("alt+m", {
    description: "Cycle the permission mode: auto, manual, yolo",
    handler: async (ctx) => {
      const next = MODES[(MODES.indexOf(shared.mode) + 1) % MODES.length]!;
      shared.setMode(next);
      ctx.ui.notify(`Permission mode: ${next}${next === "yolo" ? " (everything but hard denies runs without asking)" : ""}`, next === "yolo" ? "warning" : "info");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    const tool = event.toolName;
    const pctx = permissionContext(ctx, tool);
    const input = (event.input ?? {}) as Record<string, unknown>;
    const info = pi.getAllTools().find((t) => t.name === tool);
    const classified = classifyToolCall(tool, input, pctx, info?.annotations ? { annotations: info.annotations } : {});
    // A PreToolUse hook's allow or ask (its deny already blocked the call); never past a deny or an always-ask rule.
    const verdict = applyHookDecision(classified, hookDecisionOf(event));
    const mode = shared.mode;
    const r = route(verdict.level, mode);
    const base = {
      session: ctx.sessionManager.getSessionId(),
      tool,
      input: summarize(input),
      cwd: ctx.cwd,
      mode,
      level: verdict.level,
      rule: verdict.rule,
      reason: verdict.reason,
      ...(event.parentToolCallId ? { parent: event.parentToolCallId } : {}),
    };

    // Spec mode is read-only for every agent: enforced here, not only in the prompt (Droid).
    // A GET of a URL the user or an earlier web result gave is read-only too, so research still works.
    if (shared.readOnly && classified.level !== "allow" && classified.rule !== "web-seen") {
      log({ ...base, route: "block", outcome: "blocked", by: "spec-mode" });
      return { block: true, reason: shared.readOnly.reason };
    }

    if (r === "run") {
      if (verdict.level !== "allow" && verdict.level !== "auto") log({ ...base, route: r, outcome: "ran" });
      return undefined;
    }
    if (r === "block") {
      log({ ...base, route: r, outcome: "blocked" });
      return { block: true, reason: denyMessage(verdict) };
    }

    const grant = grantFor(tool, input, verdict, pctx);
    if (grants.has(grant.key)) {
      log({ ...base, route: r, outcome: "ran", by: "grant", grant: grant.key });
      return undefined;
    }

    let review: ReviewResult | undefined;
    if (r === "reviewer" && reviewer) {
      if (!child) ctx.ui.setStatus("b4agent.review", "reviewing…");
      try {
        review = await reviewer.review(
          buildReviewInput({ messages: child ? shared.userMessages() : userMessages(ctx), tool, input, verdict, ctx: pctx, userRules: config.rules }),
          ctx.signal,
        );
      } finally {
        if (!child) ctx.ui.setStatus("b4agent.review", undefined);
      }
      const reviewLog = { decision: review.decision, by: review.by, reason: review.reason, ms: review.ms, ...(review.scores ? { scores: review.scores } : {}), ...(review.model ? { model: review.model } : {}), ...(review.errors ? { errors: review.errors } : {}) };
      if (review.decision === "allow") {
        log({ ...base, route: r, outcome: "ran", by: "reviewer", review: reviewLog });
        return undefined;
      }
      Object.assign(base, { review: reviewLog });
    }

    return askUser(ctx, tool, input, verdict, review, grant, base);
  });

  async function askUser(
    ctx: ExtensionContext,
    tool: string,
    input: Record<string, unknown>,
    verdict: Verdict,
    review: ReviewResult | undefined,
    grant: { key: string; label: string },
    base: Record<string, unknown>,
  ): Promise<ToolCallEventResult> {
    if (!ctx.hasUI) {
      log({ ...base, route: "user", outcome: "blocked", by: "headless" });
      return {
        block: true,
        reason: `Blocked: this needs the user's approval (${verdict.reason}), and nobody can answer in ${ctx.mode} mode. Do it another way or leave it for the user.`,
      };
    }
    // One dialog at a time across the main agent and every subagent; parallel tool calls queue here.
    const result = await serializeDialog(async (): Promise<ToolCallEventResult> => {
      if (grants.has(grant.key)) return {};
      const yesSession = `Yes, and don't ask again this session for ${grant.label}`;
      const why = [verdict.reason, review && `reviewer: ${review.reason}`].filter(Boolean).join("\n");
      const title = `Allow ${tool}?\n\n${describeAction(tool, input)}\n\n${why}`;
      const choice = await ctx.ui.select(title, [YES, yesSession, NO, NO_WITH_NOTE], ctx.signal ? { signal: ctx.signal } : undefined);
      if (choice === YES) {
        log({ ...base, route: "user", outcome: "ran", by: "user", choice: "yes" });
        return {};
      }
      if (choice === yesSession) {
        grants.set(grant.key, grant.label);
        shared.saveGrant(grant.key, grant.label);
        log({ ...base, route: "user", outcome: "ran", by: "user", choice: "yes-session", grant: grant.key });
        return {};
      }
      if (choice === NO_WITH_NOTE) {
        const note = await ctx.ui.input("What should the agent do instead?", "", ctx.signal ? { signal: ctx.signal } : undefined);
        log({ ...base, route: "user", outcome: "blocked", by: "user", choice: "no-note", note });
        return { block: true, reason: note?.trim() ? `The user declined this ${tool} call and said: ${note.trim()}` : `The user declined this ${tool} call.` };
      }
      log({ ...base, route: "user", outcome: "blocked", by: "user", choice: choice === NO ? "no" : "dismissed" });
      // A plain "No" stops the turn so the user can step in.
      return { block: true, reason: `The user declined this ${tool} call. Stop and wait for their next message.`, terminate: true };
    });
    return result.block ? result : {};
  }

  function permissionContext(ctx: ExtensionContext, tool: string): PermissionContext {
    // Branch and ignore checks only matter for calls that can delete or push.
    const git = /^(bash|edit|write)$/i.test(tool) ? gitInfo(ctx.cwd) : {};
    const root = git.root ?? workspace;
    const cp = checkpointStatus(root);
    return {
      cwd: ctx.cwd,
      workspace: root,
      home,
      b4agentDir: dir,
      env: { ...process.env },
      ...(git.branch ? { currentBranch: git.branch } : {}),
      ...(git.commonDir && !isInside(git.commonDir, root) ? { gitCommonDir: git.commonDir } : {}),
      realpath: realpathPrefix,
      unrecoverable: unrecoverableIn(git.root ?? workspace, { git: Boolean(git.root ?? inGit), ...(cp ? { checkpoints: cp } : {}) }),
      ...(/^web_fetch$/i.test(tool) ? { seenUrl: webSeen(ctx) } : {}),
    };
  }

  /** web_fetch provenance: URLs from the user (the main session's user, for a child) and from earlier web results. */
  function webSeen(ctx: ExtensionContext): (url: string) => boolean {
    const set = seenUrls(ctx.sessionManager.getBranch() as never, child ? { userTexts: shared.userMessages().map((m) => m.text), branchUsers: false } : {});
    return (url) => set.has(url);
  }
}

function userMessages(ctx: ExtensionContext): UserMessage[] {
  const out: UserMessage[] = [];
  for (const e of ctx.sessionManager.getBranch()) {
    if (e.type !== "message" || e.message.role !== "user") continue;
    const c = e.message.content;
    const text = typeof c === "string" ? c : c.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
    out.push({ text });
  }
  return out;
}

function denyMessage(v: Verdict): string {
  return `Blocked by b4agent's permission gate (${v.rule}): ${v.reason}.${v.fix ? " " + v.fix : ""} This rule holds in every mode, so don't look for a way around it.`;
}

function describeAction(tool: string, input: Record<string, unknown>): string {
  if (tool.toLowerCase() === "bash" && typeof input.command === "string") return indent(truncateMiddle(redact(input.command), 1200));
  if (typeof input.path === "string") return indent(input.path);
  return indent(truncateMiddle(redact(JSON.stringify(input, null, 1)), 800));
}

const indent = (s: string) => s.split("\n").slice(0, 16).map((l) => "  " + l).join("\n");

function summarize(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = typeof v === "string" ? truncateMiddle(redact(v), 2000) : v;
  return out;
}

