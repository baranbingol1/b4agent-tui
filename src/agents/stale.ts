import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Stale-read guard (plan section 2, like Claude Code and oh-my-pi): `edit`
 * and `write` fail when the file changed on disk since this agent last read
 * or wrote it, so an agent sharing the checkout re-reads instead of
 * overwriting someone else's change. It applies to the main agent too: an
 * edit you made between turns is caught the same way.
 *
 * Only files this agent has seen are checked. A file it never read can be
 * written or edited (it may know the content from bash, and `edit` already
 * fails when its old text doesn't match).
 */

interface Seen {
  mtimeMs: number;
  size: number;
}

export function resolvePath(path: string, cwd: string): string {
  let p = path.trim().replace(/^@/, "");
  if (p === "~" || p.startsWith("~/")) p = (process.env.HOME ?? homedir()) + p.slice(1);
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

function stat(path: string): Seen | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? { mtimeMs: s.mtimeMs, size: s.size } : undefined;
  } catch {
    return undefined;
  }
}

export function registerStaleGuard(pi: ExtensionAPI) {
  const seen = new Map<string, Seen>();

  pi.on("session_start", () => seen.clear());

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return undefined;
    const raw = (event.input as { path?: unknown }).path;
    if (typeof raw !== "string") return undefined;
    const path = resolvePath(raw, ctx.cwd);
    const before = seen.get(path);
    if (!before) return undefined;
    const now = stat(path);
    if (now && now.mtimeMs === before.mtimeMs && now.size === before.size) return undefined;
    seen.delete(path);
    const what = now ? "was modified" : "was deleted";
    return {
      block: true,
      reason: `${raw} ${what} since you last read it, by the user or another agent working in this folder. Read it again and redo your change on its current content; don't revert changes you didn't make.`,
    };
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.isError) return;
    if (event.toolName !== "read" && event.toolName !== "edit" && event.toolName !== "write") return;
    const raw = event.input.path;
    if (typeof raw !== "string") return;
    const path = resolvePath(raw, ctx.cwd);
    const now = stat(path);
    if (now) seen.set(path, now);
  });
}
