import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { projectDir } from "../checkpoints/store.js";
import { gitInfo } from "../permissions/git.js";

/**
 * Auto memory, after Claude Code's (https://code.claude.com/docs/en/memory):
 * markdown notes the agent writes for itself with its normal file tools.
 * Two stores, each a folder with a MEMORY.md index of one-line pointers and
 * one topic file per memory:
 *   global   ~/.b4agent/memory/
 *   project  ~/.b4agent/projects/<name>-<hash>/memory/  (shared by a repository's worktrees)
 * The first 200 lines / 25 KB of each index go into the `memory` system
 * prompt section, snapshotted at session start; topic files are read on demand.
 */

export const INDEX = "MEMORY.md";
export const MAX_LINES = 200;
export const MAX_BYTES = 25_000;

export type Scope = "global" | "project";

export interface Store {
  scope: Scope;
  dir: string;
  index: string;
}

/**
 * The folder project memory is keyed on: the main checkout of the
 * repository, so linked worktrees (and subagents working in one) share it,
 * as in Claude Code. A submodule or a bare layout has no main checkout above
 * its git dir and keys on its own root; outside git, on cwd.
 */
export function memoryProjectRoot(cwd: string): string {
  const g = gitInfo(cwd);
  if (!g.root) return cwd;
  if (g.commonDir && basename(g.commonDir) === ".git") return dirname(g.commonDir);
  return g.root;
}

export function memoryStores(b4agentDir: string, cwd: string): [Store, Store] {
  const global = join(b4agentDir, "memory");
  const project = join(projectDir(b4agentDir, memoryProjectRoot(cwd)), "memory");
  return [
    { scope: "global", dir: global, index: join(global, INDEX) },
    { scope: "project", dir: project, index: join(project, INDEX) },
  ];
}

export function readIfFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? readFileSync(path, "utf8").replace(/^﻿/, "") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The part of an index that loads: whole lines, at most MAX_LINES and
 * MAX_BYTES (UTF-8). A first line longer than MAX_BYTES is cut at a
 * character boundary. When anything is left out, a note says where the full
 * file is.
 */
export function truncateIndex(raw: string, path: string, maxLines = MAX_LINES, maxBytes = MAX_BYTES): { text: string; truncated: boolean } {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const kept: string[] = [];
  let bytes = 0;
  let partial = false;
  for (const line of lines) {
    if (kept.length >= maxLines) break;
    const b = Buffer.byteLength(line) + 1;
    if (bytes + b > maxBytes) {
      if (!kept.length) {
        const buf = Buffer.from(line, "utf8");
        let cut = maxBytes - 1;
        while (cut > 0 && (buf[cut]! & 0xc0) === 0x80) cut--;
        kept.push(buf.subarray(0, cut).toString("utf8"));
        partial = true;
      }
      break;
    }
    kept.push(line);
    bytes += b;
  }
  const truncated = partial || kept.length < lines.length;
  const text = kept.join("\n");
  if (!truncated) return { text, truncated };
  return {
    text: `${text}\n\n[MEMORY.md is truncated here: ${lines.length} lines, ${Buffer.byteLength(raw)} bytes; only the first ${maxLines} lines or ${Math.round(maxBytes / 1000)} KB load. The full file is at ${path}; read it with read. Shorten the index: one line per memory, details in topic files.]`,
    truncated,
  };
}

const escapeIndex = (s: string) => s.replaceAll("</memory_index", "<\\/memory_index");

function indexBlock(store: Store): string {
  const raw = readIfFile(store.index);
  const body = raw === undefined || raw.trim() === "" ? "(empty)" : escapeIndex(truncateIndex(raw, store.index).text);
  return `<memory_index scope="${store.scope}" path="${store.index}">\n${body}\n</memory_index>`;
}

const SAVE_GUIDANCE = `Save a memory when you learn something a future session would need and couldn't work out again:
- the user's preferences and ways of working, their corrections, and approaches they confirm;
- decisions and constraints, with the reason, that the code and git history don't show (why something is done a certain way, deadlines, who owns what);
- non-obvious project facts and where outside information lives (the issue tracker, a dashboard, a staging host);
- anything the user asks you to remember.
Don't save secrets, credentials or personal data; anything the repository, its docs or its AGENTS.md files already say or that you can derive from them (architecture, file paths, commands, a bug's fix); or the state of the current task (plans, progress, debugging notes). Most sessions save nothing.
Scope: global for the user and how they like to work everywhere; project for this repository only.
How: write the topic file (one memory per file, a short descriptive name such as feedback_testing.md, starting with frontmatter \`type: user | feedback | project | reference\` and a one-line \`description\`), then add or update its line in that store's MEMORY.md: \`- [Title](file.md): one-line hook\`. The folders are created on first write. Keep MEMORY.md short, since only its first ${MAX_LINES} lines load: one line per memory, merge duplicates, and update or delete a memory that turns out wrong instead of adding a contradicting one. Mention it briefly when you save something. If the user asks for an instruction in AGENTS.md, edit that file instead.`;

/**
 * The `memory` section. Built once per session (see src/extension/memory.ts)
 * so it is byte-stable: edits made now show up next session.
 */
export function memorySection(stores: Store[], opts: { readOnly?: boolean } = {}): string | undefined {
  const blocks = stores.map(indexBlock);
  if (opts.readOnly && blocks.every((b) => b.includes("\n(empty)\n"))) return undefined;
  const where = stores.map((s) => `- ${s.scope}: ${s.dir}/`).join("\n");
  const head = opts.readOnly
    ? `The user's persistent memory, notes the main agent keeps across sessions. Read a topic file with read when its index line looks relevant. Memory is read-only for subagents: don't edit it; if you learn something worth remembering, say so in your result.\n${where}`
    : `You have a persistent memory: markdown notes that carry what you learn across sessions, in two stores.\n${where}\nEach store's MEMORY.md is an index with one line per memory; the details are in topic files next to it. The indexes below were loaded when this session started, so changes you make now show up in the next session. Read a topic file with read when its line looks relevant. A memory says what was true when it was written: if it conflicts with what you see now, trust what you see and fix the memory.\n\n${SAVE_GUIDANCE}`;
  return `${head}\n\n${blocks.join("\n\n")}`;
}

/** Topic files in a store (every .md but the index), for /memory. */
export function topicFiles(store: Store): string[] {
  try {
    return readdirSync(store.dir).filter((f) => f.endsWith(".md") && f !== INDEX).sort();
  } catch {
    return [];
  }
}
