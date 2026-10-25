import { posix } from "node:path";
import { extract } from "./shell/commands.js";
import { staticValue } from "./shell/words.js";
import { headName } from "./shell/unwrap.js";
import type { Level, PermissionContext, Verdict } from "./types.js";

export type Mode = "auto" | "manual" | "yolo";
export const MODES: readonly Mode[] = ["auto", "manual", "yolo"];

/** Strictest first: a project may only move the mode left. */
const STRICTNESS: Record<Mode, number> = { manual: 2, auto: 1, yolo: 0 };
export const stricterMode = (a: Mode, b: Mode): Mode => (STRICTNESS[b] > STRICTNESS[a] ? b : a);

export type Route = "run" | "block" | "user" | "reviewer";

/**
 * Where a verdict goes in each mode.
 * - auto: the reviewer handles `review`; only `ask` reaches the user.
 * - manual: everything but `allow` asks the user.
 * - yolo: everything but `deny` runs.
 * `deny` blocks in every mode.
 */
export function route(level: Level, mode: Mode): Route {
  if (level === "deny") return "block";
  if (mode === "yolo") return "run";
  if (level === "allow") return "run";
  if (mode === "manual") return "user";
  if (level === "auto") return "run";
  return level === "ask" ? "user" : "reviewer";
}

export interface Grant {
  key: string;
  /** What the grant covers, for the dialog: `git push` commands, edits in `src/`. */
  label: string;
}

const SKIP_HEADS = new Set(["cd", "pushd", "popd", "export", "set", "true", ":", "echo", "sleep"]);

/**
 * A session grant ("Yes, don't ask again") covers the same rule for the same
 * kind of action: the same command and subcommand, or the same directory.
 * Never a whole tool, so approving one `curl` doesn't approve every network call
 * with a different rule.
 */
export function grantFor(tool: string, input: Record<string, unknown>, verdict: Verdict, ctx: PermissionContext): Grant {
  const name = tool.toLowerCase();
  if (name === "bash" && typeof input.command === "string") {
    const prefix = commandPrefix(input.command, ctx);
    return { key: `bash:${verdict.rule}:${prefix}`, label: `similar \`${prefix}\` commands` };
  }
  // web_fetch grants are per host ("always for this domain"); an exfiltration ask is granted only for its own rule.
  if (name === "web_fetch" && typeof input.url === "string") {
    let host: string | undefined;
    try {
      host = new URL(input.url.trim()).hostname.toLowerCase();
    } catch {
      host = undefined;
    }
    if (host) {
      const scope = verdict.level === "ask" ? `${verdict.rule}:` : "";
      return { key: `web_fetch:${scope}${host}`, label: verdict.level === "ask" ? `web_fetch URLs like this one on ${host}` : `web_fetch requests to ${host}` };
    }
  }
  const path = typeof input.path === "string" ? input.path : undefined;
  if (path) {
    const abs = path.startsWith("/") ? path : path.startsWith("~/") ? ctx.home + path.slice(1) : posix.resolve(ctx.cwd, path);
    const dir = posix.dirname(abs);
    const shown = dir.startsWith(ctx.workspace + "/") ? posix.relative(ctx.workspace, dir) + "/" : dir === ctx.workspace ? "the workspace root" : dir.replace(ctx.home, "~");
    return { key: `${name}:${verdict.rule}:${dir}`, label: `${name} calls in ${shown}` };
  }
  return { key: `${name}:${verdict.rule}`, label: `${tool} calls` };
}

function commandPrefix(command: string, ctx: PermissionContext): string {
  const ext = extract(command, ctx.cwd, ctx.home);
  const top = ext.commands.filter((c) => c.depth === 0 && c.argv.length);
  const main = top.find((c) => !SKIP_HEADS.has(headName(c.argv[0]) ?? "")) ?? top[0];
  if (!main) return command.trim().split(/\s+/).slice(0, 2).join(" ");
  const head = headName(main.argv[0]) ?? main.argv[0]!.text;
  const sub = main.argv[1] ? staticValue(main.argv[1]) : undefined;
  return sub && /^[a-z][a-z0-9:_-]*$/.test(sub) ? `${head} ${sub}` : head;
}
