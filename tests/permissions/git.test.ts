import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gitInfo, realpathPrefix, unrecoverableIn } from "../../src/permissions/git.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "b4-git-"));
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  g("init", "-q", "-b", "feature/x");
  writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n.env\n");
  mkdirSync(join(root, "src/deep"), { recursive: true });
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "src/a.ts"), "a");
  writeFileSync(join(root, "src/deep/debug.log"), "x");
  writeFileSync(join(root, "dist/out.js"), "x");
  writeFileSync(join(root, "notes.txt"), "untracked but small");
  writeFileSync(join(root, "big.bin"), Buffer.alloc(6 * 1024 * 1024));
  g("add", ".gitignore", "src/a.ts");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  symlinkSync("/etc", join(root, "etc-link"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("git facts", () => {
  it("finds the root and branch", () => {
    expect(gitInfo(join(root, "src"))).toEqual({ root, branch: "feature/x", commonDir: join(root, ".git") });
    expect(gitInfo(tmpdir())).toEqual({});
  });

  it("reports a worktree's shared git dir, which lies outside it", () => {
    const wt = mkdtempSync(join(tmpdir(), "b4-wt-"));
    rmSync(wt, { recursive: true });
    execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", wt], { stdio: "ignore" });
    try {
      expect(gitInfo(wt)).toMatchObject({ root: wt, commonDir: join(root, ".git") });
    } finally {
      execFileSync("git", ["-C", root, "worktree", "remove", "--force", wt], { stdio: "ignore" });
    }
  });

  it("flags ignored paths, directories holding them, and globs matching them", () => {
    const u = unrecoverableIn(root);
    expect(u(join(root, "dist"))).toMatch(/gitignored.*dist\//);
    expect(u(join(root, "dist/out.js"))).toMatch(/gitignored/);
    expect(u(join(root, "src"))).toMatch(/src\/deep\/debug\.log/);
    expect(u(join(root, "**/*.log"))).toMatch(/debug\.log/);
    expect(u(join(root, "big.bin"))).toMatch(/too large/);
  });

  it("follows what checkpoints capture: default-excluded folders, checkpoints off, and folders outside git", () => {
    expect(unrecoverableIn(root)(join(root, "node_modules/react"))).toMatch(/node_modules/);
    expect(unrecoverableIn(root, { checkpoints: { ok: false, reason: "too many files" } })(join(root, "src/a.ts"))).toMatch(/checkpoints are off: too many files/);
    expect(unrecoverableIn(root, { checkpoints: { ok: true } })(join(root, "src/a.ts"))).toBeUndefined();
    const plain = unrecoverableIn(root, { git: false });
    expect(plain(join(root, "notes.txt"))).toBeUndefined();
    expect(plain(join(root, "big.bin"))).toMatch(/too large/);
    expect(plain(join(root, "src"))).toMatch(/not a git repository/);
  });

  it("leaves tracked and small untracked paths prompt-free", () => {
    const u = unrecoverableIn(root);
    expect(u(join(root, "src/a.ts"))).toBeUndefined();
    expect(u(join(root, "notes.txt"))).toBeUndefined();
    expect(u(join(root, "**/*.tmp"))).toBeUndefined();
    expect(u(join(root, "missing"))).toBeUndefined();
    expect(u("/elsewhere/dist")).toBeUndefined();
  });

  it("resolves symlinks in the existing prefix", () => {
    expect(realpathPrefix(join(root, "etc-link/new/file"))).toBe("/etc/new/file");
  });
});
