import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { projectDir } from "../checkpoints/store.js";

/**
 * Opt-in worktree isolation for subagents (plan section 2).
 *
 * Location: ~/.b4agent/worktrees/<project>-<hash>/<agent>, outside the repo
 * like Codex and oh-my-pi. The worktree starts from HEAD plus your
 * uncommitted changes and untracked files, so the child sees what you see.
 * `.worktreeinclude` (gitignore syntax, like Codex and Claude Code) copies
 * matching ignored files such as `.env`; ignored `node_modules` folders are
 * symlinked (like nicobailon) so the child doesn't need its own install.
 *
 * The baseline is a commit made inside the worktree after setup (oh-my-pi),
 * so edits made elsewhere meanwhile never show up as the child's changes.
 * Changes come back as a binary patch the parent applies after `git apply --check`.
 */

export interface Worktree {
  name: string;
  /** The user's repository root. */
  root: string;
  path: string;
  /** Baseline commit inside the worktree. */
  base: string;
  /** Symlinked dependency folders, relative to the worktree, kept out of patches. */
  links: string[];
}

export class WorktreeError extends Error {}

function git(cwd: string, args: string[], input?: string): Promise<string> {
  return new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
    env.GIT_TERMINAL_PROMPT = "0";
    const child = execFile("git", ["-C", cwd, "-c", "core.quotepath=false", ...args], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env }, (err, stdout, stderr) =>
      err ? fail(new WorktreeError(`git ${args[0]}: ${stderr.trim() || err.message}`)) : done(stdout),
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

const nul = (s: string) => s.split("\0").filter(Boolean);
const IDENTITY = ["-c", "user.name=b4agent", "-c", "user.email=b4agent@localhost", "-c", "commit.gpgsign=false"];

export function worktreePath(b4agentDir: string, root: string, name: string): string {
  const project = projectDir(b4agentDir, root);
  return join(b4agentDir, "worktrees", project.slice(project.lastIndexOf("/") + 1), name);
}

function copy(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  const st = lstatSync(from);
  if (st.isSymbolicLink() || !st.isFile()) return;
  copyFileSync(from, to);
}

export async function createWorktree(root: string, b4agentDir: string, name: string): Promise<Worktree> {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    throw new WorktreeError("worktree isolation needs a git repository with at least one commit");
  }
  const path = worktreePath(b4agentDir, root, name);
  if (existsSync(path)) {
    await git(root, ["worktree", "remove", "--force", path]).catch(() => undefined);
    rmSync(path, { recursive: true, force: true });
    await git(root, ["worktree", "prune"]).catch(() => undefined);
  }
  mkdirSync(dirname(path), { recursive: true });
  await git(root, ["worktree", "add", "--detach", "--quiet", path, "HEAD"]);
  try {
    // Your uncommitted tracked changes, then untracked files.
    const diff = await git(root, ["diff", "HEAD", "--binary"]);
    if (diff.trim()) await git(path, ["apply", "--binary", "--whitespace=nowarn"], diff);
    for (const f of nul(await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]))) {
      if (!f.endsWith("/")) copy(join(root, f), join(path, f));
    }
    if (existsSync(join(root, ".worktreeinclude"))) {
      const listed = nul(await git(root, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${join(root, ".worktreeinclude")}`]));
      for (const f of listed) if (!f.split("/").includes("node_modules")) copy(join(root, f), join(path, f));
    }
    const links: string[] = [];
    for (const d of nul(await git(root, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]))) {
      const rel = d.replace(/\/$/, "");
      if (rel.split("/").at(-1) !== "node_modules" || rel.split("/").length > 4) continue;
      const target = join(path, rel);
      if (existsSync(target) || !existsSync(dirname(target))) continue;
      symlinkSync(join(root, rel), target, "dir");
      links.push(rel);
    }
    const exclude = links.map((l) => `:(exclude)${l}`);
    await git(path, ["add", "-A", "--", ".", ...exclude]);
    await git(path, [...IDENTITY, "commit", "--quiet", "--no-verify", "--allow-empty", "-m", "b4agent: worktree baseline"]);
    const base = (await git(path, ["rev-parse", "HEAD"])).trim();
    return { name, root, path, base, links };
  } catch (e) {
    await removeWorktree({ name, root, path, base: "", links: [] });
    throw e;
  }
}

export interface Patch {
  /** Patch file, or undefined when nothing changed. */
  file?: string;
  files: string[];
  stat: string;
}

/** Everything the child changed since the baseline, saved as a binary patch next to the session. */
export async function capturePatch(wt: Worktree, outFile: string): Promise<Patch> {
  const exclude = wt.links.map((l) => `:(exclude)${l}`);
  await git(wt.path, ["add", "-A", "--", ".", ...exclude]);
  const files = nul(await git(wt.path, ["diff", "--cached", "--name-only", "--no-renames", "-z", wt.base]));
  if (!files.length) return { files: [], stat: "" };
  const patch = await git(wt.path, ["diff", "--cached", "--binary", "--no-renames", wt.base]);
  const stat = (await git(wt.path, ["diff", "--cached", "--stat", "--no-renames", wt.base])).trim();
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, patch);
  return { file: outFile, files, stat };
}

/** Checks the patch against the current files first, so a conflict is reported instead of half-applied. */
export async function applyPatch(root: string, file: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await git(root, ["apply", "--check", "--binary", file]);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  await git(root, ["apply", "--binary", file]);
  return { ok: true };
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.root, ["worktree", "remove", "--force", wt.path]).catch(() => undefined);
  rmSync(wt.path, { recursive: true, force: true });
  await git(wt.root, ["worktree", "prune"]).catch(() => undefined);
}
