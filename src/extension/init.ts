import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { gitInfo } from "../permissions/git.js";
import { assetDir } from "../prompt.js";

/**
 * /init (plan section 7): asks the main agent to write or improve the
 * project's AGENTS.md, with the brief in prompt/init.md.
 *
 * The brief draws on (all read 2026-10-21):
 * - OpenCode `packages/opencode/src/command/template/initialize.txt` (MIT): the "would an agent
 *   miss this?" test, executable sources over prose, one batch of questions at most, improve in place.
 * - Claude Code's /init (docs: code.claude.com/docs/en/memory): commands including a single test,
 *   big-picture architecture only, no repeating, suggest improvements to an existing file.
 * - Codex `codex-rs/tui/prompt_for_init_command.md` (Apache-2.0): the section list (layout,
 *   commands, style, testing, commit/PR conventions) and a short target length. Codex leaves an
 *   existing AGENTS.md alone; we improve it, as OpenCode and Claude Code do.
 * - Amp (ampcode.com/news/AGENT.md): fold in other agents' rule files (.cursorrules, CLAUDE.md...).
 * Text is b4agent's own; questions go through ask_user (src/tools/ask-user.ts).
 */

export interface InitTarget {
  path: string;
  exists: boolean;
  /** A CLAUDE.md next to it, when there is no AGENTS.md. */
  claude?: string;
  /** The session's folder relative to the root, when it is a subfolder. */
  subdir?: string;
}

export function initTarget(cwd: string): InitTarget {
  const root = gitInfo(cwd).root ?? cwd;
  const path = join(root, "AGENTS.md");
  const exists = existsSync(path);
  const claude = join(root, "CLAUDE.md");
  const sub = relative(root, cwd);
  return { path, exists, ...(!exists && existsSync(claude) ? { claude } : {}), ...(sub && !sub.startsWith("..") ? { subdir: sub } : {}) };
}

export function initBrief(t: InitTarget, focus: string): string {
  const state = t.exists
    ? "It already exists: improve it in place."
    : t.claude
      ? `There is none yet, but there is a \`${t.claude}\`: use it as a source.`
      : "There is none yet.";
  const notes: string[] = [];
  if (focus.trim()) notes.push(`The user's focus for this run (honour it): ${focus.trim()}`);
  if (t.subdir) notes.push(`The session started in the subfolder \`${t.subdir}\`. If that folder is a project of its own (its own manifest), write \`${t.subdir}/AGENTS.md\` for it instead, and don't repeat what the root AGENTS.md says.`);
  const update = t.exists
    ? "## 4. Improve, don't overwrite\n\nThe file exists, so edit it in place with the edit tool; never replace it wholesale. Keep what is still true and useful, and the owner's wording and order where they work. Fix what is stale (commands that no longer exist, moved paths), cut fluff and anything that repeats the README, and add what is missing. If it is already good, change nothing and say so."
    : t.claude
      ? "## 4. Existing CLAUDE.md\n\nBuild AGENTS.md from the CLAUDE.md and what you verified, and leave CLAUDE.md untouched. Tell the user they can replace CLAUDE.md with a symlink to AGENTS.md if both tools should share one file."
      : "";
  return readFileSync(join(assetDir("prompt"), "init.md"), "utf8")
    .replaceAll("{{path}}", t.path)
    .replaceAll("{{state}}", state)
    .replaceAll("{{focus}}", notes.length ? `\n${notes.join("\n\n")}\n` : "")
    .replaceAll("{{update}}", update)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export default function init(pi: ExtensionAPI) {
  pi.registerCommand("init", {
    description: "Write or improve AGENTS.md for this project (commands, layout, conventions, gotchas); optional focus",
    handler: async (args, ctx) => pi.sendUserMessage(initBrief(initTarget(ctx.cwd), args)),
  });
}
