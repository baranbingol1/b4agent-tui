import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckpointStore, MAX_UNTRACKED_BYTES, resetStores } from "../../src/checkpoints/store.js";

let root: string;
let ws: string;
let b4: string;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
const write = (rel: string, text: string) => {
  mkdirSync(join(ws, rel, ".."), { recursive: true });
  writeFileSync(join(ws, rel), text);
};
const read = (rel: string) => readFileSync(join(ws, rel), "utf8");

beforeEach(() => {
  resetStores();
  root = mkdtempSync(join(tmpdir(), "b4cp-"));
  ws = join(root, "proj");
  b4 = join(root, "b4");
  mkdirSync(ws);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function initRepo() {
  sh(ws, "init", "-q", "-b", "main");
  write(".gitignore", "data/\n");
  write("a.ts", "a1\n");
  write("b.ts", "b1\n");
  write("c.ts", "c1\n");
  sh(ws, "add", ".");
  sh(ws, "commit", "-qm", "init");
}

/** Restores every path that differs between two trees to its state in `to`. */
async function rewind(store: CheckpointStore, from: string, to: string) {
  const files = await store.changedFiles(to, from);
  await store.restore(new Map(files.map((f) => [f, to])));
}

describe("checkpoint store in a git repository", () => {
  it("restores edits, deletes, renames and new files without touching ignored, oversized or nested-repo files", async () => {
    initRepo();
    write("untracked.txt", "u1\n");
    write("data/db.sqlite", "precious\n");
    const store = await CheckpointStore.open(ws, b4, { inGit: true });
    const before = (await store.capture()).tree;

    write("a.ts", "a2\n");
    unlinkSync(join(ws, "b.ts"));
    renameSync(join(ws, "c.ts"), join(ws, "d.ts"));
    write("src/new.ts", "new\n");
    write("untracked.txt", "u2\n");
    write("data/db.sqlite", "changed by agent\n");
    writeFileSync(join(ws, "big.bin"), Buffer.alloc(MAX_UNTRACKED_BYTES + 1));
    mkdirSync(join(ws, "vendor/lib"), { recursive: true });
    sh(join(ws, "vendor/lib"), "init", "-q");
    write("vendor/lib/x.c", "x\n");
    const after = await store.capture();
    expect(after.skipped).toEqual(["big.bin"]);

    expect((await store.changedFiles(before, after.tree)).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "src/new.ts", "untracked.txt"]);
    await rewind(store, after.tree, before);

    expect(read("a.ts")).toBe("a1\n");
    expect(read("b.ts")).toBe("b1\n");
    expect(read("c.ts")).toBe("c1\n");
    expect(existsSync(join(ws, "d.ts"))).toBe(false);
    expect(existsSync(join(ws, "src/new.ts"))).toBe(false);
    expect(read("untracked.txt")).toBe("u1\n");
    // Never captured, so never deleted or reverted.
    expect(read("data/db.sqlite")).toBe("changed by agent\n");
    expect(statSync(join(ws, "big.bin")).size).toBe(MAX_UNTRACKED_BYTES + 1);
    expect(read("vendor/lib/x.c")).toBe("x\n");
  });

  it("never touches the user's index, refs or stash", async () => {
    initRepo();
    write("a.ts", "staged\n");
    sh(ws, "add", "a.ts");
    write("a.ts", "worktree\n");
    const indexBefore = readFileSync(join(ws, ".git/index"));
    const refsBefore = sh(ws, "for-each-ref");
    const store = await CheckpointStore.open(ws, b4, { inGit: true });
    const t0 = (await store.capture()).tree;
    write("a.ts", "agent\n");
    const t1 = (await store.capture()).tree;
    await rewind(store, t1, t0);

    expect(read("a.ts")).toBe("worktree\n");
    expect(readFileSync(join(ws, ".git/index")).equals(indexBefore)).toBe(true);
    expect(sh(ws, "for-each-ref")).toBe(refsBefore);
    expect(sh(ws, "stash", "list")).toBe("");
    expect(sh(ws, "diff", "--cached", "--name-only")).toBe("a.ts\n");
  });

  it("restores symlinks and the executable bit, and a file the agent replaced with a folder", async () => {
    initRepo();
    write("run.sh", "#!/bin/sh\n");
    chmodSync(join(ws, "run.sh"), 0o755);
    symlinkSync("a.ts", join(ws, "link"));
    write("conf", "file\n");
    const store = await CheckpointStore.open(ws, b4, { inGit: true });
    const t0 = (await store.capture()).tree;
    chmodSync(join(ws, "run.sh"), 0o644);
    unlinkSync(join(ws, "link"));
    symlinkSync("b.ts", join(ws, "link"));
    unlinkSync(join(ws, "conf"));
    write("conf/inner.json", "{}\n");
    const t1 = (await store.capture()).tree;
    await rewind(store, t1, t0);

    expect(statSync(join(ws, "run.sh")).mode & 0o111).not.toBe(0);
    expect(readlinkSync(join(ws, "link"))).toBe("a.ts");
    expect(read("conf")).toBe("file\n");
  });

  it("serializes concurrent captures and shares one store per worktree", async () => {
    initRepo();
    const [s1, s2] = await Promise.all([CheckpointStore.open(ws, b4, { inGit: true }), CheckpointStore.open(ws, b4, { inGit: true })]);
    expect(s1).toBe(s2);
    const trees = await Promise.all([s1.capture(), s1.capture(), s1.capture()]);
    expect(new Set(trees.map((t) => t.tree)).size).toBe(1);
  });

  it("follows .git/info/exclude and the default excludes, even when .gitignore doesn't list them", async () => {
    initRepo();
    writeFileSync(join(ws, ".git/info/exclude"), "secret.local\n");
    write("secret.local", "s\n");
    write("node_modules/pkg/index.js", "x\n");
    const store = await CheckpointStore.open(ws, b4, { inGit: true });
    const t0 = (await store.capture()).tree;
    write("secret.local", "s2\n");
    write("node_modules/pkg/index.js", "y\n");
    write("a.ts", "a2\n");
    expect(await store.changedFiles(t0, (await store.capture()).tree)).toEqual(["a.ts"]);
  });
});

describe("checkpoint store outside git", () => {
  it("captures and restores a plain folder", async () => {
    write("notes.md", "n1\n");
    const store = await CheckpointStore.open(ws, b4, { inGit: false });
    const t0 = (await store.capture()).tree;
    write("notes.md", "n2\n");
    write("new.md", "x\n");
    await rewind(store, (await store.capture()).tree, t0);
    expect(read("notes.md")).toBe("n1\n");
    expect(existsSync(join(ws, "new.md"))).toBe(false);
  });

  it("refuses the home folder", async () => {
    await expect(CheckpointStore.open(ws, b4, { inGit: false, home: ws })).rejects.toThrow(/not a project folder/);
  });
});
