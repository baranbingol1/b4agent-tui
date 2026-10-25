import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MODES, stricterMode, type Mode } from "./gate.js";
import type { UserRules } from "./review/input.js";

export interface PermissionConfig {
  mode: Mode;
  /** "auto": Jev when a TypeSafe key exists, then the LLM. "off": review-level calls ask the user. */
  reviewer: "auto" | "jev" | "llm" | "off";
  /** `provider/id` of the LLM reviewer. */
  reviewerModel: string;
  rules: UserRules;
}

export const DEFAULTS: PermissionConfig = {
  mode: "auto",
  reviewer: "auto",
  reviewerModel: "openai-codex/gpt-6-luna",
  rules: { allow: [], soft_deny: [], environment: [] },
};

export function b4agentDir(): string {
  return process.env.B4AGENT_HOME ?? join(homedir(), ".b4agent");
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);

/**
 * Reads `permissions` from ~/.b4agent/b4agent.json. A project's
 * `.pi/b4agent.json` can only make the mode stricter: a repository must not
 * be able to turn on YOLO or add allow rules (plan section 0).
 */
export function loadConfig(dir: string, projectRoot: string | undefined, errors: string[] = []): PermissionConfig {
  const global = readJson(join(dir, "b4agent.json"));
  if (existsSync(join(dir, "b4agent.json")) && !global) errors.push(`could not parse ${join(dir, "b4agent.json")}`);
  const p = (global?.permissions ?? {}) as Record<string, unknown>;
  const rules = (p.rules ?? {}) as Record<string, unknown>;
  const cfg: PermissionConfig = {
    mode: isMode(p.mode) ? p.mode : DEFAULTS.mode,
    reviewer: p.reviewer === "jev" || p.reviewer === "llm" || p.reviewer === "off" || p.reviewer === "auto" ? p.reviewer : DEFAULTS.reviewer,
    reviewerModel: typeof p.reviewerModel === "string" ? p.reviewerModel : DEFAULTS.reviewerModel,
    rules: { allow: strings(rules.allow), soft_deny: strings(rules.soft_deny), environment: strings(rules.environment) },
  };
  if (projectRoot) {
    const project = readJson(join(projectRoot, ".pi", "b4agent.json"));
    const pm = (project?.permissions as Record<string, unknown> | undefined)?.mode;
    if (isMode(pm)) cfg.mode = stricterMode(cfg.mode, pm);
  }
  return cfg;
}
