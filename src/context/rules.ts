import { readdirSync } from "node:fs";
import { join, matchesGlob, relative, sep } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Candidate, isInside, keyFor, readText, realpathOr } from "./nested.js";

/**
 * Path-scoped rules (Claude Code's `.claude/rules/`, plan section 19): a
 * markdown file under `<cwd>/.claude/rules/` or `<cwd>/.agents/rules/` whose
 * frontmatter has `paths:` (a YAML list or a comma-separated string of globs,
 * relative to cwd) loads when a matching file is touched. Rules without
 * `paths` are left out: Claude Code loads them at session start, which here
 * would be a system prompt change, so put such text in AGENTS.md instead.
 */

export const RULE_DIRS = [".claude/rules", ".agents/rules"];
const MAX_RULE_FILES = 200;

export interface Rule {
  key: string;
  file: string;
  globs: string[];
}

function walk(dir: string, out: string[], depth = 0): void {
  if (depth > 4 || out.length >= MAX_RULE_FILES) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if ((e.isFile() || e.isSymbolicLink()) && e.name.endsWith(".md")) out.push(p);
  }
}

export function globsOf(frontmatter: Record<string, unknown>): string[] {
  const v = frontmatter.paths;
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return list.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean);
}

/** The path-scoped rules under cwd. Files that resolve outside cwd are skipped. */
export function loadRules(realCwd: string): Rule[] {
  const files: string[] = [];
  for (const d of RULE_DIRS) walk(join(realCwd, d), files);
  const rules: Rule[] = [];
  for (const file of files) {
    if (!isInside(realpathOr(file), realCwd)) continue;
    const text = readText(file);
    if (text === undefined) continue;
    let globs: string[] = [];
    try {
      globs = globsOf(parseFrontmatter(text).frontmatter);
    } catch {
      // Unparsable frontmatter: treated as a rule without paths (Claude Code does the same), so not loaded here.
    }
    if (globs.length) rules.push({ key: keyFor(file, realCwd), file, globs });
  }
  return rules;
}

/** Rules whose globs match one of the touched files (real paths inside cwd). */
export function ruleCandidates(rules: Rule[], realFiles: string[], realCwd: string): Candidate[] {
  const rels = realFiles.filter((f) => f !== realCwd && isInside(f, realCwd)).map((f) => relative(realCwd, f).split(sep).join("/"));
  return rules
    .filter((r) => rels.some((rel) => r.globs.some((g) => matchesGlob(rel, g))))
    .map((r) => ({
      key: r.key,
      file: r.file,
      load: () => {
        const text = readText(r.file);
        if (text === undefined) return undefined;
        try {
          return parseFrontmatter(text).body;
        } catch {
          return text;
        }
      },
    }));
}
