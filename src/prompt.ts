import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedBuildSystemPromptOptions } from "@earendil-works/pi-coding-agent";

/** A folder shipped with b4agent (`agents/`, `prompt/`), found from this module's location in src or dist. */
export function assetDir(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, name))) return join(dir, name);
    dir = dirname(dir);
  }
  return join(dirname(fileURLToPath(import.meta.url)), "..", name);
}

let identity: string | undefined;
export function b4agentIdentity(): string {
  identity ??= readFileSync(join(assetDir("prompt"), "system.md"), "utf8").trim();
  return identity;
}

/**
 * Replaces Pi's opening paragraph with `preamble` and keeps its tool list
 * and rules, which Pi drops when a custom prompt is set (plan section 5).
 * A user's own SYSTEM.md (already in `customPrompt`) is left alone.
 */
export function setPreamble(o: NormalizedBuildSystemPromptOptions, preamble: string) {
  if (o.customPrompt) return;
  o.customPrompt = preamble;
  const declared = o.selectedTools.filter((n) => !o.hiddenTools.includes(n));
  const visible = declared.filter((n) => o.toolSnippets[n]);
  o.sections.tools ??= `${visible.length ? visible.map((n) => `- ${n}: ${o.toolSnippets[n]}`).join("\n") : "(none)"}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
  o.sections.rules ??= rules(declared, o.toolGuidelines, o.promptGuidelines);
}

/** Pi's rule list (core/system-prompt.js buildRules), which isn't exported. */
function rules(tools: string[], toolGuidelines: Record<string, string[]>, promptGuidelines: string[]): string {
  const out: string[] = [];
  const add = (r: string) => {
    const t = r.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const has = (n: string) => tools.includes(n);
  if ((has("bash") || has("powershell")) && !has("grep") && !has("find") && !has("ls")) {
    add(has("bash") && has("powershell") ? "Use bash or PowerShell for file operations like listing, searching, and finding files" : has("powershell") ? "Use PowerShell for file operations like listing, searching, and finding files" : "Use bash for file operations like ls, rg, find");
  }
  for (const n of tools) for (const r of toolGuidelines[n] ?? []) add(r);
  for (const r of promptGuidelines) add(r);
  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return out.map((r) => `- ${r}`).join("\n");
}
