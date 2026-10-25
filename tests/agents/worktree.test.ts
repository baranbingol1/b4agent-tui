import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch, capturePatch, createWorktree, removeWorktree } from "../../src/agents/worktree.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

function repo() {
  const home = mkdtempSync(join(tmpdir(), "b4wt-"));
  const root = join(home, "proj");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "a1\n");
  writeFileSync(join(root, "src", "b.ts"), "b1\n");
  writeFileSync(join(root, ".gitignore"), ".env\nnode_modules/\ndist/\n");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return { home: join(home, ".b4agent"), root };
}

describe("worktrees", () => {
  it("start from what you see, and come back as only the child's changes", async () => {
    const { home, root } = repo();
    writeFileSync(join(root, "src", "a.ts"), "a-uncommitted\n");
    writeFileSync(join(root, "src", "new.ts"), "untracked\n");
    writeFileSync(join(root, ".env"), "SECRET=1\n");
    writeFileSync(join(root, ".worktreeinclude"), ".env\n");
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "");
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "out.js"), "");

    const wt = await createWorktree(root, home, "general-1");
    expect(wt.path.startsWith(join(home, "worktrees") + "/")).toBe(true);
    expect(readFileSync(join(wt.path, "src", "a.ts"), "utf8")).toBe("a-uncommitted\n");
    expect(readFileSync(join(wt.path, "src", "new.ts"), "utf8")).toBe("untracked\n");
    expect(readFileSync(join(wt.path, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(lstatSync(join(wt.path, "node_modules")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(wt.path, "dist"))).toBe(false);

    // The child edits b.ts; meanwhile you edit a.ts in your checkout.
    writeFileSync(join(wt.path, "src", "b.ts"), "b-child\n");
    writeFileSync(join(wt.path, "src", "c.ts"), "c-child\n");
    writeFileSync(join(root, "src", "a.ts"), "a-you\n");
    const patch = await capturePatch(wt, join(home, "general-1.patch"));
    expect(patch.files.sort()).toEqual(["src/b.ts", "src/c.ts"]);

    expect(await applyPatch(root, patch.file!)).toEqual({ ok: true });
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("a-you\n");
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("b-child\n");
    expect(readFileSync(join(root, "src", "c.ts"), "utf8")).toBe("c-child\n");

    await removeWorktree(wt);
    expect(existsSync(wt.path)).toBe(false);
    expect(git(root, "worktree", "list")).not.toContain("general-1");
  });

  it("refuses a patch that conflicts and leaves your files alone", async () => {
    const { home, root } = repo();
    const wt = await createWorktree(root, home, "w");
    writeFileSync(join(wt.path, "src", "a.ts"), "a-child\n");
    writeFileSync(join(wt.path, "src", "b.ts"), "b-child\n");
    const patch = await capturePatch(wt, join(home, "w.patch"));
    writeFileSync(join(root, "src", "a.ts"), "a-you\n");
    const r = await applyPatch(root, patch.file!);
    expect(r.ok).toBe(false);
    expect(readFileSync(join(root, "src", "a.ts"), "utf8")).toBe("a-you\n");
    expect(readFileSync(join(root, "src", "b.ts"), "utf8")).toBe("b1\n");
    await removeWorktree(wt);
  });

  it("reports no changes as an empty patch", async () => {
    const { home, root } = repo();
    const wt = await createWorktree(root, home, "idle");
    expect(await capturePatch(wt, join(home, "idle.patch"))).toEqual({ files: [], stat: "" });
    await removeWorktree(wt);
  });
});
