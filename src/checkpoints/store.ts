import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/**
 * File checkpoints (plan section 17): a shadow git repository per worktree
 * under ~/.b4agent/projects/<key>/checkpoints. Snapshots are `write-tree`
 * trees built from the shadow repo's own index, so the user's .git, index,
 * stash and refs are never touched. Same model as OpenCode's snapshot store.
 *
 * Trees have no refs, so the shadow repo must never be garbage collected
 * (gc.auto=0 and nothing here runs gc).
 */

/** Untracked files above this size are not captured. */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
/** Outside a git repository there is no .gitignore, so refuse workspaces with more new files than this. */
export const MAX_FILES_OUTSIDE_GIT = 20_000;
/** Dependency and cache folders never captured, even when a repository doesn't ignore them. */
export const DEFAULT_EXCLUDES = [
  "node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache",
  ".next", ".nuxt", ".turbo", ".parcel-cache", ".gradle", "target", ".DS_Store",
];

const CONFIG: [string, string][] = [
  ["core.autocrlf", "false"],
  ["core.symlinks", "true"],
  ["core.fsmonitor", "false"],
  ["core.longpaths", "true"],
  ["core.hooksPath", "/dev/null"],
  ["core.quotepath", "false"],
  ["gc.auto", "0"],
  ["index.version", "4"],
];

/** True when a workspace-relative path lies in a default-excluded folder. */
export function excludedByDefault(rel: string): boolean {
  return rel.split("/").some((s) => DEFAULT_EXCLUDES.includes(s));
}

/** `~/.b4agent/projects/<name>-<hash>`: one folder per worktree. */
export function projectDir(b4agentDir: string, workspace: string): string {
  let real = workspace;
  try {
    real = realpathSync(workspace);
  } catch {
    // keep the given path
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  const name = basename(real).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  return join(b4agentDir, "projects", `${name}-${hash}`);
}

export class CheckpointError extends Error {}

interface RunOptions {
  input?: string;
  index?: string;
  cwd?: string;
}

function gitEnv(index?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.LC_ALL = "C";
  if (index) env.GIT_INDEX_FILE = index;
  return env;
}

/** The git subcommand, for error messages: skips global options and their values. */
function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--git-dir" || a === "--work-tree" || a === "-c" || a === "-C") i++;
    else if (!a.startsWith("-")) return a;
  }
  return "";
}

function git(args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((done, fail) => {
    const child = execFile(
      "git",
      args,
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: gitEnv(opts.index), ...(opts.cwd ? { cwd: opts.cwd } : {}) },
      (err, stdout, stderr) => (err ? fail(new CheckpointError(`git ${subcommand(args)}: ${stderr.trim() || err.message}`)) : done(stdout)),
    );
    // git may exit before reading stdin (an error, or nothing to read); a broken pipe must not crash Pi.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(opts.input ?? "");
  });
}

const nul = (s: string) => s.split("\0").filter(Boolean);

function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface FileStat {
  added: number;
  deleted: number;
  binary: boolean;
}

export interface CaptureResult {
  tree: string;
  /** Untracked files left out because they are too large. */
  skipped: string[];
}

/** One store per shadow repository in this process, so captures and restores serialize. */
const stores = new Map<string, Promise<CheckpointStore>>();

export class CheckpointStore {
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly workspace: string,
    readonly gitDir: string,
    /** Exclude file of the user's repository, or undefined outside git. */
    private readonly sourceExclude: string | undefined,
  ) {}

  /**
   * Opens (and creates on first use) the shadow repository for a workspace.
   * `inGit` is the workspace's own repository root, or undefined outside git.
   */
  static open(workspace: string, b4agentDir: string, opts: { inGit: boolean; home?: string }): Promise<CheckpointStore> {
    const real = realpathSync(workspace);
    if (!opts.inGit && (real === "/" || real === (opts.home && existsSync(opts.home) ? realpathSync(opts.home) : undefined))) {
      return Promise.reject(new CheckpointError(`not capturing ${real}: it is not a project folder`));
    }
    const gitDir = join(projectDir(b4agentDir, real), "checkpoints");
    let store = stores.get(gitDir);
    if (!store) {
      store = CheckpointStore.create(real, gitDir, opts.inGit);
      stores.set(gitDir, store);
      store.catch(() => stores.delete(gitDir));
    }
    return store;
  }

  private static async create(workspace: string, gitDir: string, inGit: boolean): Promise<CheckpointStore> {
    let sourceExclude: string | undefined;
    if (inGit) {
      const p = (await git(["-C", workspace, "rev-parse", "--git-path", "info/exclude"])).trim();
      sourceExclude = resolve(workspace, p);
    }
    if (!existsSync(join(gitDir, "HEAD"))) {
      // Initialize beside the target and rename into place, so two processes can't half-create it.
      mkdirSync(dirname(gitDir), { recursive: true });
      const tmp = `${gitDir}.init-${process.pid}-${randomBytes(4).toString("hex")}`;
      await git(["--git-dir", tmp, "init", "--quiet"]);
      for (const [k, v] of CONFIG) await git(["--git-dir", tmp, "config", k, v]);
      try {
        renameSync(tmp, gitDir);
      } catch (e) {
        rmSync(tmp, { recursive: true, force: true });
        if (!existsSync(join(gitDir, "HEAD"))) throw e;
      }
    }
    return new CheckpointStore(workspace, gitDir, sourceExclude);
  }

  private base(): string[] {
    return ["--git-dir", this.gitDir, "--work-tree", this.workspace, "--literal-pathspecs", "-c", "core.quotepath=false"];
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Snapshots the whole worktree (respecting .gitignore and the default excludes) and returns its tree id. */
  capture(): Promise<CaptureResult> {
    return this.locked(async () => {
      this.writeExcludes();
      const index = join(this.gitDir, "index");
      // Work on a private copy of the index and swap it in at the end, like OpenCode:
      // no index.lock contention and no half-written index if we die midway.
      const tmp = `${index}.b4-${process.pid}-${randomBytes(4).toString("hex")}`;
      if (existsSync(index)) copyFileSync(index, tmp);
      try {
        const run = (args: string[], input?: string) => git([...this.base(), ...args], { index: tmp, ...(input !== undefined ? { input } : {}) });
        const [untrackedOut, changedOut, ignoredOut] = await Promise.all([
          run(["ls-files", "-z", "--others", "--exclude-standard"]),
          run(["diff-files", "--name-only", "-z"]),
          run(["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]),
        ]);
        const ignored = new Set(nul(ignoredOut));
        const untracked = nul(untrackedOut);
        if (!this.sourceExclude && untracked.length > MAX_FILES_OUTSIDE_GIT) {
          throw new CheckpointError(`${untracked.length} files and no .gitignore; too many to checkpoint`);
        }
        const skipped: string[] = [];
        const add: string[] = [];
        for (const p of untracked) {
          if (p.endsWith("/")) continue; // a nested repository
          try {
            const st = lstatSync(join(this.workspace, p));
            if (st.isFile() && st.size > MAX_UNTRACKED_BYTES) {
              skipped.push(p);
              continue;
            }
          } catch {
            continue; // vanished
          }
          add.push(p);
        }
        const remove = new Set(ignored);
        for (const p of nul(changedOut)) {
          if (remove.has(p)) continue;
          // A file replaced by a folder: drop the file; the folder's files come in as untracked.
          if (isRealDir(join(this.workspace, p))) remove.add(p);
          else add.push(p);
        }
        if (remove.size) await run(["update-index", "--force-remove", "-z", "--stdin"], [...remove].join("\0") + "\0");
        if (add.length) await run(["update-index", "--add", "--remove", "--replace", "-z", "--stdin"], add.join("\0") + "\0");
        const tree = (await run(["write-tree"])).trim();
        if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new CheckpointError(`write-tree returned ${tree}`);
        renameSync(tmp, index);
        return { tree, skipped };
      } finally {
        rmSync(tmp, { force: true });
      }
    });
  }

  private writeExcludes() {
    let source = "";
    if (this.sourceExclude) {
      try {
        source = readFileSync(this.sourceExclude, "utf8");
      } catch {
        // no exclude file
      }
    }
    const lines = ["# written by b4agent on every capture", ...DEFAULT_EXCLUDES.map((d) => (d === ".DS_Store" ? d : `${d}/`)), source];
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), lines.join("\n"));
  }

  /** Paths that differ between two trees. A rename gives both paths, so undoing it restores one and removes the other. */
  async changedFiles(from: string, to: string): Promise<string[]> {
    if (from === to) return [];
    return nul(await git([...this.base(), "diff", "--name-only", "--no-renames", "-z", from, to]));
  }

  /** Line counts per changed path between two trees. */
  async stats(from: string, to: string): Promise<Map<string, FileStat>> {
    const out = new Map<string, FileStat>();
    if (from === to) return out;
    const text = await git([...this.base(), "diff", "--numstat", "--no-renames", "-z", from, to]);
    for (const rec of nul(text)) {
      const [a, d, ...rest] = rec.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      out.set(path, { added: a === "-" ? 0 : Number(a), deleted: d === "-" ? 0 : Number(d), binary: a === "-" });
    }
    return out;
  }

  /**
   * Puts each path back to its content in the given tree. Paths absent from
   * their tree are deleted (files the agent created). Only the listed paths
   * are touched.
   */
  restore(files: Map<string, string>): Promise<void> {
    return this.locked(async () => {
      const byTree = new Map<string, string[]>();
      for (const [path, tree] of files) {
        if (path.startsWith("/") || path.split("/").includes("..")) throw new CheckpointError(`refusing to restore ${path}`);
        byTree.set(tree, [...(byTree.get(tree) ?? []), path]);
      }
      const absent: string[] = [];
      for (const [tree, paths] of byTree) {
        const inTree = new Set(nul(await git([...this.base(), "ls-tree", "-r", "-z", "--full-tree", "--name-only", tree])));
        const present = paths.filter((p) => inTree.has(p));
        absent.push(...paths.filter((p) => !inTree.has(p)));
        if (!present.length) continue;
        // A throwaway index: checkout must not disturb the capture index.
        const index = join(this.gitDir, `index.restore-${process.pid}-${randomBytes(4).toString("hex")}`);
        try {
          for (const p of present) this.clearWay(p);
          await git([...this.base(), "checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], { index, input: present.join("\0") + "\0" });
        } finally {
          rmSync(index, { force: true });
        }
      }
      // Checkouts first, so one failing removal can't stop the other files from being restored.
      for (const p of absent) {
        const abs = join(this.workspace, p);
        try {
          if (!lstatSync(abs).isDirectory()) rmSync(abs, { force: true });
        } catch {
          // already gone
        }
      }
    });
  }

  /** A directory now sitting where the checkpoint has a file (or a file where a parent directory belongs) blocks checkout. */
  private clearWay(rel: string) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = join(this.workspace, ...parts.slice(0, i));
      try {
        if (!lstatSync(parent).isDirectory()) rmSync(parent, { force: true });
      } catch {
        return;
      }
    }
  }
}

/** For tests: forget cached stores. */
export function resetStores() {
  stores.clear();
}

export type CheckpointStatus = { ok: true } | { ok: false; reason: string };

/** Whether checkpoints work for a workspace in this process; read by the permission gate. */
const status = new Map<string, CheckpointStatus>();

export function setCheckpointStatus(workspace: string, s: CheckpointStatus) {
  status.set(workspace, s);
}

export function checkpointStatus(workspace: string): CheckpointStatus | undefined {
  return status.get(workspace);
}
