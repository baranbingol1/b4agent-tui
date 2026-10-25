/**
 * Permission verdicts.
 *
 * Levels, from least to most restrictive:
 * - allow:  runs in every mode without a prompt.
 * - auto:   runs without a prompt in auto mode; manual mode asks the user.
 * - review: auto mode sends it to the reviewer; manual mode asks the user.
 * - ask:    always asks the user. The reviewer cannot clear it.
 * - deny:   blocked in every mode, YOLO included.
 */
export type Level = "allow" | "auto" | "review" | "ask" | "deny";

const RANK: Record<Level, number> = { allow: 0, auto: 1, review: 2, ask: 3, deny: 4 };

export interface Verdict {
  level: Level;
  /** Stable rule id, used in the log and in tests. */
  rule: string;
  /** Human and model facing explanation. */
  reason: string;
  /** For denies: what the model should do instead. */
  fix?: string;
  /** Absolute paths the call deletes or writes, as resolved by the rules. */
  targets?: string[];
}

export interface PermissionContext {
  /** Directory the command runs in. */
  cwd: string;
  /** Workspace (project) root. */
  workspace: string;
  home: string;
  /** b4agent home, normally ~/.b4agent. */
  b4agentDir: string;
  /**
   * The environment the bash process inherits (Pi's shell env). With it,
   * variables resolve to their real values and unset ones to "". Without it,
   * inherited variables are treated as unknown.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * The workspace repository's shared git dir (`git rev-parse --git-common-dir`),
   * when it lies outside the workspace, as it does for a worktree.
   */
  gitCommonDir?: string;
  /** Current git branch of the workspace, if known. Used for force-push checks. */
  currentBranch?: string;
  /**
   * Resolves symlinks of the longest existing prefix of an absolute path.
   * Injected so the rules stay pure and testable. Defaults to the identity.
   */
  realpath?: (absolutePath: string) => string;
  /**
   * Why deleting this workspace path can't be undone (gitignored, or too large
   * for a checkpoint), or undefined when checkpoints and git can restore it.
   * The path may hold glob characters (`dist/*`). Injected like `realpath`.
   */
  unrecoverable?: (absolutePath: string) => string | undefined;
  /**
   * Whether a URL (normalized: no fragment, no trailing slash) appeared in a
   * user message or an earlier web_fetch / web_search result. web_fetch's
   * provenance rule; undefined means nothing counts as seen.
   */
  seenUrl?: (url: string) => boolean;
}

export function stricter(a: Verdict, b: Verdict): Verdict {
  return RANK[b.level] > RANK[a.level] ? b : a;
}

/** The most restrictive verdict; the first one wins a tie. `fallback` only applies when there are none. */
export function strictest(verdicts: Iterable<Verdict>, fallback: Verdict): Verdict {
  let out: Verdict | undefined;
  for (const v of verdicts) out = out ? stricter(out, v) : v;
  return out ?? fallback;
}

export function rank(level: Level): number {
  return RANK[level];
}

