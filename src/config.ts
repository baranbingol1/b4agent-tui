import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { b4agentDir } from "./permissions/config.js";

export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
const THINKING: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Per-type overrides from `agents.<type>` in b4agent.json. Every field is optional. */
export interface AgentOverride {
  model?: string;
  thinking?: Thinking;
  /** Replaces the type's system prompt body. */
  prompt?: string;
  tools?: string[];
  description?: string;
  isolation?: "none" | "worktree";
  maxTurns?: number;
  maxCalls?: number;
}

export type Complexity = "light" | "medium" | "heavy";
export const COMPLEXITIES: readonly Complexity[] = ["light", "medium", "heavy"];

export interface B4Config {
  /**
   * Model roles: each is a list of candidates tried in order. A candidate is
   * `provider/id`, `*\/id` (any provider with a login), or `@role`, with an
   * optional `:thinking` suffix.
   */
  roles: Record<string, string[]>;
  agents: Record<string, AgentOverride>;
  /**
   * The `agent` tool's `complexity`, as a model spec per level (Droid).
   * Undefined keeps the type's own model.
   */
  complexity: Record<Complexity, string | undefined>;
  /** The main agent's preamble, replacing b4agent's identity text. */
  prompt?: string;
  jobs: { autoBackgroundSeconds: number };
  /** How deep subagents may nest: main is depth 0, its children 1. */
  maxDepth: number;
}

/** GPT-6 defaults through the ChatGPT (Codex) login, plan section 10. */
export const DEFAULT_ROLES: Record<string, string[]> = {
  main: ["openai-codex/gpt-6.1-sol:high", "*/gpt-6.1-sol:high"],
  worker: ["openai-codex/gpt-6.1-sol:medium", "*/gpt-6.1-sol:medium"],
  smol: ["openai-codex/gpt-6-luna:low", "*/gpt-6-luna:low"],
  slow: ["openai-codex/gpt-6-astra:high", "*/gpt-6-astra:high"],
  recap: ["@smol"],
};

/** light → the small fast role, medium → the type's default, heavy → the strongest role. */
export const DEFAULT_COMPLEXITY: Record<Complexity, string | undefined> = { light: "@smol", medium: undefined, heavy: "@slow" };

export function configPath(dir = b4agentDir()): string {
  return join(dir, "b4agent.json");
}

/** Reads ~/.b4agent/b4agent.json. Bad or missing fields fall back to defaults; errors are reported, never thrown. */
export function loadB4Config(dir = b4agentDir(), errors: string[] = []): B4Config {
  let raw: Record<string, unknown> = {};
  const path = configPath(dir);
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (e) {
      errors.push(`could not parse ${path}: ${(e as Error).message}`);
    }
  }
  const models = (raw.models ?? {}) as Record<string, unknown>;
  const roles: Record<string, string[]> = { ...DEFAULT_ROLES };
  for (const [k, v] of Object.entries((models.roles ?? {}) as Record<string, unknown>)) {
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    if (list.length) roles[k] = list;
    else errors.push(`models.roles.${k} must be a string or a list of strings`);
  }
  // models.complexity: a spec (`@role`, a bare role name, or `provider/id`), or null for the type's own model.
  const complexity = { ...DEFAULT_COMPLEXITY };
  for (const [k, v] of Object.entries((models.complexity ?? {}) as Record<string, unknown>)) {
    if (!COMPLEXITIES.includes(k as Complexity)) errors.push(`models.complexity.${k}: use light, medium or heavy`);
    else if (v === null || v === "default") complexity[k as Complexity] = undefined;
    else if (typeof v === "string" && v.trim()) complexity[k as Complexity] = /^[@*]|\//.test(v.trim()) ? v.trim() : `@${v.trim()}`;
    else errors.push(`models.complexity.${k} must be a model spec, a role name or null`);
  }
  const agents: Record<string, AgentOverride> = {};
  for (const [k, v] of Object.entries((raw.agents ?? {}) as Record<string, unknown>)) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    const a: AgentOverride = {};
    if (typeof o.model === "string") a.model = o.model;
    if (typeof o.thinking === "string" && THINKING.includes(o.thinking)) a.thinking = o.thinking as Thinking;
    if (typeof o.prompt === "string") a.prompt = o.prompt;
    if (Array.isArray(o.tools)) a.tools = o.tools.filter((x): x is string => typeof x === "string");
    if (typeof o.description === "string") a.description = o.description;
    if (o.isolation === "worktree" || o.isolation === "none") a.isolation = o.isolation;
    if (typeof o.max_turns === "number" && o.max_turns > 0) a.maxTurns = Math.floor(o.max_turns);
    if (typeof o.max_calls === "number" && o.max_calls > 0) a.maxCalls = Math.floor(o.max_calls);
    agents[k] = a;
  }
  const jobs = (raw.jobs ?? {}) as Record<string, unknown>;
  const sec = typeof jobs.autoBackgroundSeconds === "number" && jobs.autoBackgroundSeconds >= 0 ? jobs.autoBackgroundSeconds : 60;
  const depth = typeof raw.maxDepth === "number" && raw.maxDepth >= 0 ? Math.floor(raw.maxDepth) : 2;
  return {
    roles,
    agents,
    complexity,
    ...(typeof raw.prompt === "string" ? { prompt: raw.prompt } : {}),
    jobs: { autoBackgroundSeconds: sec },
    maxDepth: depth,
  };
}

/** The parts of Pi's ModelRegistry used to resolve roles. */
export interface ModelLookup {
  getAll(): Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
}

export interface ResolvedModel {
  model: Model<Api>;
  thinking?: Thinking;
  /** The candidate that matched, for messages. */
  spec: string;
}

/**
 * Resolves a model spec (`@role`, `provider/id`, `*\/id`, each with an
 * optional `:thinking`) to the first candidate that exists and has a login.
 * Explicit thinking on the spec wins over the role's.
 */
export function resolveModel(spec: string, roles: Record<string, string[]>, models: ModelLookup, seen = new Set<string>()): ResolvedModel | undefined {
  let thinking: Thinking | undefined;
  let base = spec.trim();
  const colon = base.lastIndexOf(":");
  if (colon > 0 && THINKING.includes(base.slice(colon + 1))) {
    thinking = base.slice(colon + 1) as Thinking;
    base = base.slice(0, colon);
  }
  if (base.startsWith("@")) {
    const role = base.slice(1);
    if (seen.has(role)) return undefined;
    seen.add(role);
    for (const c of roles[role] ?? []) {
      const r = resolveModel(c, roles, models, seen);
      if (r) return thinking ? { ...r, thinking } : r;
    }
    return undefined;
  }
  const slash = base.indexOf("/");
  if (slash < 0) return undefined;
  const provider = base.slice(0, slash);
  const id = base.slice(slash + 1);
  const all = models.getAll();
  const hit = all.find((m) => (provider === "*" || m.provider === provider) && m.id === id && models.hasConfiguredAuth(m));
  return hit ? { model: hit, spec, ...(thinking ? { thinking } : {}) } : undefined;
}
