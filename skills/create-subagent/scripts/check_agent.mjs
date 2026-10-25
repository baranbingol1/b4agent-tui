#!/usr/bin/env node
// Checks a subagent type file with b4agent's own parser (src/agents/types.ts),
// so the rules can't drift from what b4agent loads. Part of b4agent (MIT).
//
//   node check_agent.mjs <file.md>
//
// Prints JSON: { ok, errors, warnings, type } and exits 1 when the file would
// not load. Warnings cover things the loader accepts silently but that are
// probably mistakes (a model role that doesn't exist, an unknown tool name,
// a misspelled field, a file name that differs from the type name).
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const file = process.argv[2];
if (!file) {
  console.error("usage: node check_agent.mjs <file.md>");
  process.exit(2);
}

// skills/create-subagent/scripts -> the b4agent package root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const typesJs = join(root, "dist", "src", "agents", "types.js");
const configJs = join(root, "dist", "src", "config.js");
if (!existsSync(typesJs)) {
  console.log(JSON.stringify({ ok: false, errors: [`b4agent's parser not found at ${typesJs} (run npm run build in the b4agent checkout)`] }));
  process.exit(1);
}
const { parseAgentType } = await import(pathToFileURL(typesJs).href);
const { loadB4Config } = await import(pathToFileURL(configJs).href);

const text = readFileSync(file, "utf8");
const parsed = parseAgentType(text, "user", file);
const errors = [];
const warnings = [];
if (typeof parsed === "string") {
  errors.push(parsed);
} else {
  if (basename(file) !== `${parsed.name}.md`) warnings.push(`file name ${basename(file)} differs from the type name; name it ${parsed.name}.md`);
  if (!parsed.prompt) errors.push("the body (the system prompt) is empty");

  const configErrors = [];
  const config = loadB4Config(undefined, configErrors);
  const role = /^@([^:]+)/.exec(parsed.model)?.[1];
  if (role && !config.roles[role]) warnings.push(`model role @${role} is not defined (roles: ${Object.keys(config.roles).map((r) => "@" + r).join(", ")})`);

  const known = new Set([
    "read", "bash", "edit", "write", "grep", "find", "ls",
    "agent", "message", "agents", "ask_user", "web_fetch", "web_search", "painter",
    "get_schedule", "set_schedule", "update_schedule", "clear_schedule",
  ]);
  for (const t of parsed.tools ?? []) if (!known.has(t)) warnings.push(`tool "${t}" is not a b4agent or Pi builtin tool; fine only if an extension or MCP server provides it`);

  const fields = new Set(["name", "description", "model", "thinking", "tools", "isolation", "context", "max_turns", "max_calls", "output", "locked"]);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  for (const m of fm.matchAll(/^([A-Za-z_][\w-]*)\s*:/gm)) if (!fields.has(m[1])) warnings.push(`unknown frontmatter field "${m[1]}" is ignored`);
  for (const [k, ok] of [["thinking", parsed.thinking], ["max_turns", parsed.maxTurns], ["max_calls", parsed.maxCalls]]) {
    if (new RegExp(`^${k}\\s*:`, "m").test(fm) && ok === undefined) warnings.push(`${k} has an invalid value and is ignored`);
  }
  if (/^isolation\s*:\s*(?!worktree\b|none\b)\S/m.test(fm)) warnings.push(`isolation must be none or worktree; it is treated as none`);
  if (/^context\s*:\s*(?!fork\b|fresh\b)\S/m.test(fm)) warnings.push(`context must be fresh or fork; it is treated as fresh`);
}
const { prompt, ...summary } = typeof parsed === "string" ? {} : parsed;
console.log(JSON.stringify({ ok: errors.length === 0, errors, warnings, ...(typeof parsed === "string" ? {} : { type: { ...summary, promptChars: prompt.length } }) }, null, 2));
process.exit(errors.length ? 1 : 0);
