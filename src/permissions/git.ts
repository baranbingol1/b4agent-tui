import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { posix } from "node:path";
import { excludedByDefault, MAX_UNTRACKED_BYTES, type CheckpointStatus } from "../checkpoints/store.js";
import { isInside } from "./paths.js";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", cwd, "-c", "core.quotepath=off", ...args], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

export interface GitInfo {
  /** Repository root, or undefined outside a repository. */
  root?: string;
  branch?: string;
  /** The shared git dir; outside the root for a worktree. */
  commonDir?: string;
}

export function gitInfo(cwd: string): GitInfo {
  const root = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  if (!root) return {};
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"])?.trim();
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])?.trim();
  return { root, ...(branch ? { branch } : {}), ...(common ? { commonDir: common } : {}) };
}

/**
 * Explains why deleting a path inside the workspace can't be undone, or
 * returns undefined when checkpoints (or git) can restore it. Mirrors what
 * the checkpoint store captures: in a repository, everything except
 * gitignored files, default-excluded folders and new untracked files over
 * 5 MiB; outside git, everything except those folders and large files.
 * Glob characters in the path are matched by git's pathspec globbing.
 */
export function unrecoverableIn(root: string, opts: { git?: boolean; checkpoints?: CheckpointStatus } = {}): (absolutePath: string) => string | undefined {
  const inGit = opts.git ?? true;
  return (p) => {
    if (!isInside(p, root)) return undefined;
    if (opts.checkpoints && !opts.checkpoints.ok) return `checkpoints are off: ${opts.checkpoints.reason}`;
    const rel = posix.relative(root, p) || ".";
    if (excludedByDefault(rel)) return `checkpoints skip dependency and cache folders like ${rel.split("/").find((s) => excludedByDefault(s))}/`;
    const glob = /[*?[]/.test(rel);
    if (inGit) {
      // `--directory` collapses ignored directories, which keeps node_modules short but would
      // report a whole ignored directory for any glob, so globs list files instead.
      const out = glob
        ? git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", `:(glob)${rel}`])
        : git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory", "--", rel]);
      if (out === undefined) return "git could not list ignored files, so this may not be restorable";
      const ignored = out.split("\0").filter(Boolean);
      if (ignored.length) {
        const shown = ignored.slice(0, 3).join(", ");
        return `gitignored: ${shown}${ignored.length > 3 ? ` and ${ignored.length - 3} more` : ""}`;
      }
    }
    if (!glob) {
      try {
        const st = lstatSync(p);
        if (!inGit && st.isDirectory()) return "not a git repository, so checkpoints may have skipped large or excluded files in it";
        if (st.isFile() && st.size > MAX_UNTRACKED_BYTES && !(inGit && git(root, ["ls-files", "--", rel])?.trim())) {
          return `untracked and ${(st.size / 1024 / 1024).toFixed(1)} MiB, too large for a checkpoint`;
        }
      } catch {
        // Missing paths have nothing to lose.
      }
    } else if (!inGit) return "not a git repository, so checkpoints may have skipped large or excluded files it matches";
    return undefined;
  };
}

/** Resolves symlinks in the longest existing prefix of an absolute path. */
export function realpathPrefix(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(head);
      return tail.length ? posix.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = posix.dirname(head);
      if (parent === head) return p;
      tail.push(posix.basename(head));
      head = parent;
    }
  }
}
