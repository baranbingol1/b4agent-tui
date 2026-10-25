import { posix } from "node:path";
import type { PermissionContext, Verdict } from "./types.js";

/** Marks a path component that came from a guarded, known non-empty expansion. */
export const PLACEHOLDER = "\u0000";

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  return path;
}

/** Lexically resolves a path. Returns undefined when it is relative and the cwd is unknown. */
export function resolvePath(path: string, cwd: string | undefined, home: string): string | undefined {
  const expanded = expandHome(path, home);
  if (expanded.startsWith("/")) return posix.normalize(expanded).replace(/(.)\/+$/, "$1");
  if (cwd === undefined) return undefined;
  return posix.resolve(cwd, expanded);
}

export function isInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

function isAncestorOrSelf(path: string, of: string): boolean {
  return isInside(of, path);
}

const PURE_GLOB = /^(\*+|\.\*|\{\*,\.\*\}|\{\.\*,\*\})$/;

/**
 * Critical paths: deleting them recursively is never what the user wants.
 * `/`, every top-level directory, the home directory and its ancestors, the
 * workspace and its ancestors, and a pure glob (`*`) directly under any of them.
 */
export function isCriticalPath(absolute: string, ctx: PermissionContext): boolean {
  const base = posix.basename(absolute);
  if (PURE_GLOB.test(base)) return isCriticalDir(posix.dirname(absolute), ctx) || absolute === "/*";
  return isCriticalDir(absolute, ctx);
}

function isCriticalDir(p: string, ctx: PermissionContext): boolean {
  if (p === "/") return true;
  const parts = p.split("/").filter(Boolean);
  if (parts.length === 1 && !parts[0]!.includes(PLACEHOLDER)) return true;
  if (p.includes(PLACEHOLDER)) return false;
  return isAncestorOrSelf(p, ctx.home) || isAncestorOrSelf(p, ctx.workspace);
}

const PROTECTED_SEGMENTS = new Set([
  ".git", ".vscode", ".idea", ".husky", ".devcontainer", ".claude", ".pi",
]);
const PROTECTED_NAMES = new Set([
  ".gitconfig", ".gitmodules", ".npmrc", ".yarnrc", ".yarnrc.yml", ".envrc", ".mcp.json",
  ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile",
  ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout",
]);

/** Credential stores, relative to home. Reads and writes always ask. */
const HOME_CREDENTIAL_DIRS = [
  ".ssh", ".aws", ".gnupg", ".kube", ".docker", ".azure", ".config/gcloud", ".config/gh",
  ".local/share/keyrings", "Library/Keychains", ".pi/agent",
];
const HOME_CREDENTIAL_FILES = [".netrc", ".pgpass", ".pypirc", ".git-credentials", ".npmrc"];
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_EXAMPLE = /^\.env\.(example|sample|template|dist)$/;
const KEY_FILE = /^(id_(rsa|dsa|ecdsa|ed25519)(_sk)?|.+\.(pem|key|p12|pfx))$/;

export function isCredentialPath(p: string, ctx: PermissionContext): boolean {
  for (const d of HOME_CREDENTIAL_DIRS) if (isInside(p, posix.join(ctx.home, d))) return true;
  for (const f of HOME_CREDENTIAL_FILES) if (p === posix.join(ctx.home, f)) return true;
  if (isInside(p, posix.join(ctx.b4agentDir, "agent"))) {
    const rel = posix.relative(posix.join(ctx.b4agentDir, "agent"), p);
    if (rel.startsWith("auth.json")) return true;
  }
  if (p === "/etc/shadow" || p === "/etc/gshadow" || p === "/etc/sudoers" || isInside(p, "/etc/sudoers.d")) return true;
  const base = posix.basename(p);
  if (ENV_FILE.test(base) && !ENV_EXAMPLE.test(base)) return true;
  return KEY_FILE.test(base) && !base.endsWith(".pub");
}

export function isProtectedPath(p: string, ctx: PermissionContext, opts: { ignoreGit?: boolean } = {}): boolean {
  const parts = p.split("/").filter(Boolean);
  if (parts.some((s) => PROTECTED_SEGMENTS.has(s) && !(opts.ignoreGit && s === ".git"))) return true;
  if (PROTECTED_NAMES.has(posix.basename(p))) return true;
  if (isInside(p, posix.join(ctx.home, ".config/fish"))) return true;
  // b4agent's own user-level config surfaces (section 0 of the plan).
  if (isInside(p, posix.join(ctx.b4agentDir, "agents"))) return true;
  if (isInside(p, posix.join(ctx.b4agentDir, "agent"))) return true;
  return false;
}

/**
 * Files that guard the guard: the permission config, its log, and the
 * checkpoint stores (~/.b4agent/projects/<key>/checkpoints) that make deletes
 * undoable. Writing to a folder that holds them counts too.
 */
export function isOwnGuardPath(p: string, ctx: PermissionContext): boolean {
  if (p === posix.join(ctx.b4agentDir, "b4agent.json") || p.startsWith(posix.join(ctx.b4agentDir, "permissions.log"))) return true;
  if (p === ctx.b4agentDir) return true;
  const projects = posix.join(ctx.b4agentDir, "projects");
  if (!isInside(p, projects)) return false;
  const parts = posix.relative(projects, p).split("/").filter(Boolean);
  return parts.length <= 1 || parts[1] === "checkpoints";
}

/**
 * Inside the `.git` of some other repository (a fresh clone in /tmp), and
 * protected for no other reason. The workspace's own repository, including
 * the shared git dir of a worktree, stays protected: its hooks and config run
 * whenever git runs here.
 */
function isForeignGitInternal(p: string, real: string, ctx: PermissionContext): boolean {
  for (const x of [p, real]) if (isProtectedPath(x, ctx) && (!x.split("/").includes(".git") || isProtectedPath(x, ctx, { ignoreGit: true }))) return false;
  for (const x of new Set([p, real])) {
    if (isInside(x, ctx.workspace)) return false;
    if (ctx.gitCommonDir && isInside(x, ctx.gitCommonDir)) return false;
  }
  return true;
}

/** Where a write lands, after the symlink check. */
export function classifyWrite(p: string, ctx: PermissionContext, what = "write"): Verdict {
  if (isOwnGuardPath(p, ctx)) {
    return { level: "deny", rule: "own-guard", reason: `${what} to the permission config, its log or the checkpoint store`, fix: "Ask the user to change these themselves." };
  }
  const real = ctx.realpath ? ctx.realpath(p) : p;
  // A symlink into a credential store or a protected folder counts as that folder.
  if (isCredentialPath(p, ctx) || isCredentialPath(real, ctx)) return { level: "ask", rule: "credentials", reason: `${what} to a credential store: ${p}` };
  if (isProtectedPath(p, ctx) || isProtectedPath(real, ctx)) {
    if (isForeignGitInternal(p, real, ctx)) return { level: "review", rule: "foreign-git", reason: `${what} inside the .git folder of a repository outside the workspace: ${p}` };
    return { level: "ask", rule: "protected-path", reason: `${what} to a protected path: ${p}${real !== p ? ` -> ${real}` : ""}` };
  }
  if (isInside(real, ctx.b4agentDir)) return { level: "allow", rule: "b4agent-home", reason: `${what} inside ~/.b4agent` };
  if (isInside(p, ctx.workspace)) {
    if (!isInside(real, ctx.workspace)) return { level: "review", rule: "symlink-escape", reason: `${what} through a symlink that leaves the workspace: ${p} -> ${real}` };
    return { level: "auto", rule: "workspace-write", reason: `${what} inside the workspace` };
  }
  return { level: "review", rule: "outside-workspace", reason: `${what} outside the workspace: ${p}` };
}

export function classifyRead(p: string, ctx: PermissionContext): Verdict {
  if (isCredentialPath(p, ctx)) return { level: "ask", rule: "credentials", reason: `read of a credential file: ${p}` };
  return { level: "allow", rule: "read", reason: "read" };
}
