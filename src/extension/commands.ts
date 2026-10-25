import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assetDir } from "../prompt.js";

/**
 * /review and /security-review (plan sections 7 and 16): shortcuts that ask the
 * main agent to review a change with reviewer subagents (split into parallel
 * reviewers by area when the change is large). Findings are P0-P3, or exactly LGTM.
 *
 *   /review                      the uncommitted changes
 *   /review main                 this branch against main
 *   /review abc123, /review #42  a commit, a pull request
 *   /review src/auth only        the uncommitted changes, focused
 */
export function describeTarget(args: string, cwd: string): string {
  const a = args.trim();
  if (!a) return "the uncommitted changes (staged, unstaged and untracked files)";
  if (/^#\d+$|^\d+$/.test(a)) return `pull request #${a.replace("#", "")} (use gh pr view and gh pr diff)`;
  const git = (...x: string[]) => {
    try {
      return execFileSync("git", ["-C", cwd, ...x], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  if (!/\s/.test(a) && git("rev-parse", "--verify", "--quiet", `${a}^{commit}`)) {
    const branch = git("rev-parse", "--verify", "--quiet", `refs/heads/${a}`) ?? git("rev-parse", "--verify", "--quiet", `refs/remotes/${a}`);
    return branch ? `this branch against ${a} (what would merge: the diff from the merge base)` : `commit ${a}`;
  }
  return `the uncommitted changes, with this focus from the user: "${a}" (if it names a commit, branch or PR instead, review that)`;
}

function template(name: string, target: string): string {
  return readFileSync(join(assetDir("prompt"), name), "utf8").replaceAll("{{target}}", target).trim();
}

export function registerReviewCommands(pi: ExtensionAPI) {
  pi.registerCommand("review", {
    description: "Review a change (default: uncommitted; or a branch, commit, PR, or focus): P0-P3 findings or LGTM",
    handler: async (args, ctx) => pi.sendUserMessage(template("review.md", describeTarget(args, ctx.cwd))),
  });
  pi.registerCommand("security-review", {
    description: "Security review of a change (default: uncommitted; or a branch, commit, PR): exploitable issues or LGTM",
    handler: async (args, ctx) => pi.sendUserMessage(template("security-review.md", describeTarget(args, ctx.cwd))),
  });
}
