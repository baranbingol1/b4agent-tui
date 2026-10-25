import { posix } from "node:path";
import { isInside } from "../paths.js";
import { commandVariables } from "../rules/bash.js";
import type { PermissionContext, Verdict } from "../types.js";

/**
 * What the reviewer sees. Only the user's own messages, the action and facts
 * the gate computed. Never assistant text, tool outputs or repository files:
 * those are where injected instructions hide.
 */
export interface ReviewInput {
  user: {
    /** The user's latest message: the request the action must serve. */
    latest: string;
    /** Earlier user messages, newest first. */
    earlier: string[];
  };
  action: {
    tool: string;
    input: Record<string, unknown>;
    cwd: string;
    workspace: string;
  };
  facts: ReviewFacts;
  /** The user's own prose rules from ~/.b4agent/b4agent.json. */
  user_rules?: UserRules;
}

export interface ReviewFacts {
  /** Why the gate sent this to review. */
  why_review: string;
  /** Paths the action deletes or writes, relative to the workspace when inside it. */
  paths?: string[];
  /** What each shell variable in the command expands to. */
  variables?: Record<string, string>;
  /** Whether deleted or overwritten files can be restored. */
  can_undo?: string;
  git_branch?: string;
  /** Set when a subagent makes the call. */
  agent?: string;
}

export interface UserRules {
  allow: string[];
  soft_deny: string[];
  environment: string[];
}

export interface UserMessage {
  text: string;
}

/**
 * The user's messages get about 6k tokens (estimated as characters / 4): the
 * latest in full, then earlier ones newest first until the budget runs out.
 * A request made many messages ago ("update the plan doc as you go") still
 * reaches the reviewer, and the total stays bounded for Jev and the LLM.
 */
export const USER_TOKEN_BUDGET = 6000;
const CHARS_PER_TOKEN = 4;
/** One long earlier message (a pasted log) may take at most this share, so older requests still fit. */
const EARLIER_EACH_MAX = 1500 * CHARS_PER_TOKEN;
/** Below this, a truncated message says too little to be worth including. */
const MIN_PIECE = 200;
const INPUT_FIELD_MAX = 3000;

export const estimateTokens = (s: string) => Math.ceil(s.length / CHARS_PER_TOKEN);

export function buildReviewInput(args: {
  messages: readonly UserMessage[];
  tool: string;
  input: Record<string, unknown>;
  verdict: Verdict;
  ctx: PermissionContext;
  agent?: string;
  userRules?: UserRules;
}): ReviewInput {
  const { ctx, verdict } = args;
  const texts = args.messages.map((m) => redact(m.text.trim())).filter(Boolean);
  let budget = USER_TOKEN_BUDGET * CHARS_PER_TOKEN;
  const latest = truncateMiddle(texts.at(-1) ?? "", budget);
  budget -= latest.length;
  const earlier: string[] = [];
  for (const t of texts.slice(0, -1).reverse()) {
    if (budget < MIN_PIECE) break;
    const cut = truncateMiddle(t, Math.min(EARLIER_EACH_MAX, budget));
    if (!cut) break;
    earlier.push(cut);
    budget -= cut.length;
  }

  const facts: ReviewFacts = { why_review: verdict.reason };
  const targets = verdict.targets ?? [];
  if (targets.length) facts.paths = targets.slice(0, 20).map((p) => (isInside(p, ctx.workspace) ? posix.relative(ctx.workspace, p) || "." : p));
  if (args.tool.toLowerCase() === "bash" && typeof args.input.command === "string") {
    const vars = commandVariables(args.input.command, ctx);
    if (Object.keys(vars).length) facts.variables = vars;
  }
  const undo = canUndo(verdict, targets, ctx);
  if (undo) facts.can_undo = undo;
  if (ctx.currentBranch) facts.git_branch = ctx.currentBranch;
  if (args.agent) facts.agent = args.agent;

  const out: ReviewInput = {
    user: { latest, earlier },
    action: { tool: args.tool, input: summarizeInput(args.input), cwd: ctx.cwd, workspace: ctx.workspace },
    facts,
  };
  const rules = args.userRules;
  if (rules && (rules.allow.length || rules.soft_deny.length || rules.environment.length)) out.user_rules = rules;
  return out;
}

function canUndo(verdict: Verdict, targets: string[], ctx: PermissionContext): string | undefined {
  if (verdict.rule === "unrecoverable-delete") return "no: " + (/\(([^()]*)\)$/.exec(verdict.reason)?.[1] ?? "checkpoints skip it");
  if (!targets.length) return undefined;
  if (targets.every((p) => isInside(p, ctx.workspace))) return "yes: checkpoints restore files inside the workspace";
  return "no: files outside the workspace have no checkpoint";
}

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = truncateMiddle(redact(v), INPUT_FIELD_MAX);
    else {
      const json = JSON.stringify(v) ?? "";
      out[k] = json.length > INPUT_FIELD_MAX ? truncateMiddle(redact(json), INPUT_FIELD_MAX) : v;
    }
  }
  return out;
}

/** Keeps the start and the end, which carry the request and its last clarification. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max < 200) return "";
  const head = Math.floor(max * 0.6);
  const tail = max - head - 40;
  return `${s.slice(0, head)}\n[... ${s.length - head - tail} characters cut ...]\n${s.slice(s.length - tail)}`;
}

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(sk|rk|pk)-[A-Za-z0-9_-]{20,}/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/gi,
];

/** Replaces credentials with a marker, so the reviewer still knows one is there. */
export function redact(s: string): string {
  let out = s;
  for (const re of SECRETS) out = out.replace(re, "[secret]");
  return out;
}
