import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentOverride, B4Config, Complexity, Thinking } from "../config.js";
import { assetDir } from "../prompt.js";
import { type OutputSchema, parseOutputSchema } from "./schema.js";

/**
 * A subagent type: a markdown file whose frontmatter configures the child
 * and whose body is the child's system prompt (plan section 2 and 21).
 */
export interface AgentType {
  name: string;
  description: string;
  prompt: string;
  /** Tool allowlist. Undefined: Pi's default tools plus every extension tool. */
  tools?: string[];
  /** Model spec: `@role`, `provider/id`, or `*\/id`, optionally with `:thinking`. */
  model: string;
  thinking?: Thinking;
  /** "worktree": the child works in its own git worktree by default. */
  isolation: "none" | "worktree";
  /** "fork": the child starts with a copy of the caller's conversation. */
  context: "fresh" | "fork";
  /** Turn budget: a warning 3 turns before, then the run is stopped. Undefined: no budget. */
  maxTurns?: number;
  /** Starts allowed per session. Undefined: no cap. */
  maxCalls?: number;
  /** JSON Schema the child's `submit` data must match. A call's `schema` replaces it. */
  output?: OutputSchema;
  /** The type always runs on its own model: a call's `model` and `complexity` are ignored. */
  locked: boolean;
  source: "builtin" | "user" | "project";
  path?: string;
}

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The `agents/` folder shipped with b4agent. */
export function builtinAgentsDir(): string {
  return assetDir("agents");
}

const list = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

/** Parses one type file. Returns an error string for a broken file. */
export function parseAgentType(text: string, source: AgentType["source"], path?: string): AgentType | string {
  let fm: Record<string, unknown>;
  let body: string;
  try {
    ({ frontmatter: fm, body } = parseFrontmatter(text));
  } catch (e) {
    return `${path ?? "agent"}: bad frontmatter: ${(e as Error).message}`;
  }
  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return `${path ?? "agent"}: name must be lowercase letters, digits and dashes`;
  if (typeof fm.description !== "string" || !fm.description.trim()) return `${path ?? name}: description is required`;
  const tools = list(fm.tools);
  let output: OutputSchema | undefined;
  if (fm.output !== undefined) {
    const o = parseOutputSchema(fm.output);
    if (typeof o === "string") return `${path ?? name}: output: ${o}`;
    output = o;
  }
  return {
    name,
    description: fm.description.trim(),
    prompt: body.trim(),
    ...(tools ? { tools } : {}),
    model: typeof fm.model === "string" && fm.model.trim() ? fm.model.trim() : "@main",
    ...(typeof fm.thinking === "string" && THINKING.includes(fm.thinking) ? { thinking: fm.thinking as Thinking } : {}),
    isolation: fm.isolation === "worktree" ? "worktree" : "none",
    context: fm.context === "fork" ? "fork" : "fresh",
    ...(typeof fm.max_turns === "number" && fm.max_turns > 0 ? { maxTurns: Math.floor(fm.max_turns) } : {}),
    ...(typeof fm.max_calls === "number" && fm.max_calls > 0 ? { maxCalls: Math.floor(fm.max_calls) } : {}),
    ...(output !== undefined ? { output } : {}),
    locked: fm.locked === true,
    source,
    ...(path ? { path } : {}),
  };
}

function readDir(dir: string, source: AgentType["source"], errors: string[]): AgentType[] {
  if (!existsSync(dir)) return [];
  const out: AgentType[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const path = join(dir, f);
    const t = parseAgentType(readFileSync(path, "utf8"), source, path);
    if (typeof t === "string") errors.push(t);
    else out.push(t);
  }
  return out;
}

/**
 * Builtin, then ~/.b4agent/agents, then the project's `.pi/agents` (only
 * when the project is trusted, so a repository can't redefine `general`),
 * then `agents.<type>` overrides from b4agent.json. Later sources win by name.
 */
export function loadAgentTypes(opts: {
  b4agentDir: string;
  projectRoot?: string;
  projectTrusted: boolean;
  overrides: Record<string, AgentOverride>;
  errors?: string[];
}): Map<string, AgentType> {
  const errors = opts.errors ?? [];
  const types = new Map<string, AgentType>();
  const add = (ts: AgentType[]) => ts.forEach((t) => types.set(t.name, t));
  add(readDir(builtinAgentsDir(), "builtin", errors));
  add(readDir(join(opts.b4agentDir, "agents"), "user", errors));
  if (opts.projectRoot && opts.projectTrusted) add(readDir(join(opts.projectRoot, ".pi", "agents"), "project", errors));
  for (const [name, o] of Object.entries(opts.overrides)) {
    const t = types.get(name);
    if (!t) {
      errors.push(`agents.${name} in b4agent.json names no agent type`);
      continue;
    }
    types.set(name, {
      ...t,
      ...(o.model ? { model: o.model } : {}),
      ...(o.thinking ? { thinking: o.thinking } : {}),
      ...(o.prompt ? { prompt: o.prompt } : {}),
      ...(o.tools ? { tools: o.tools } : {}),
      ...(o.description ? { description: o.description } : {}),
      ...(o.isolation ? { isolation: o.isolation } : {}),
      ...(o.maxTurns ? { maxTurns: o.maxTurns } : {}),
      ...(o.maxCalls ? { maxCalls: o.maxCalls } : {}),
    });
  }
  return types;
}

/** Tools a type can't write with, so it can share any checkout (plan section 2). */
export function isReadOnly(t: AgentType): boolean {
  return !!t.tools && !t.tools.some((x) => x === "edit" || x === "write");
}

/**
 * The model specs to try for a start, in order (plan sections 2 and 7):
 * the call's `model`, then its `complexity` mapped through
 * `models.complexity` (light → @smol, heavy → @slow; medium keeps the
 * type's model unless configured), then the type's own model. A locked type
 * only ever gets its own.
 */
export function modelCandidates(type: AgentType, call: { model?: string; complexity?: Complexity }, config: Pick<B4Config, "complexity">): string[] {
  if (type.locked) return [type.model];
  const byComplexity = call.complexity ? config.complexity[call.complexity] : undefined;
  return [...new Set([call.model?.trim(), byComplexity, type.model].filter((s): s is string => Boolean(s)))];
}
