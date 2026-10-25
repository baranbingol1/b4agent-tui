import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bashTouches, FILE_CAP, parseBlocks, RESULT_CAP, stripHtmlComments } from "../../src/context/nested.js";
import nested from "../../src/extension/nested.js";
import { Branch, fakePi } from "./fake-pi.js";

let root: string;
let cwd: string;
let branch: Branch;
let pi: ReturnType<typeof fakePi>;
let trusted: boolean;
let calls = 0;

const put = (rel: string, text: string) => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const ctx = () => ({ cwd, isProjectTrusted: () => trusted, sessionManager: { getBranch: () => branch.entries } });

/** Runs one successful tool call through the extension; returns the appended text ("" when nothing was appended). */
async function run(toolName: string, input: Record<string, unknown>, opts: { persist?: boolean; isError?: boolean } = {}): Promise<string> {
  const id = `call-${++calls}`;
  branch.call(id, toolName, input);
  const content = [{ type: "text", text: "tool output" }];
  const out = (await pi.emit("tool_result", { type: "tool_result", toolCallId: id, toolName, input, content, isError: opts.isError ?? false, details: undefined }, ctx())) as { content?: { type: string; text: string }[] } | undefined;
  const final = out?.content ?? content;
  if (opts.persist !== false) branch.result(id, toolName, final, opts.isError ?? false);
  return final.length > 1 ? final.slice(1).map((c) => c.text).join("\n") : "";
}
/** A new branch (as after /tree to the root). */
async function fresh() {
  branch = new Branch();
  await pi.emit("session_tree", {}, ctx());
}
const paths = (text: string) => parseBlocks(text).map((b) => b.key);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "b4-nested-")));
  cwd = join(root, "proj");
  put("proj/AGENTS.md", "root rules (Pi loads these)");
  put("proj/sub/AGENTS.md", "sub rules");
  put("proj/sub/a/CLAUDE.md", "a rules");
  put("proj/sub/a/x.ts", "x");
  put("proj/sub/y.ts", "y");
  put("AGENTS.md", "above cwd");
  put("outside/AGENTS.md", "outside rules");
  put("outside/z.ts", "z");
  branch = new Branch();
  branch.user("go");
  pi = fakePi();
  nested(pi.pi, { argv: [] });
  trusted = true;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("which files load", () => {
  it("walks from the target's directory up to cwd, outer to inner, cwd and above excluded", async () => {
    const text = await run("read", { path: "sub/a/x.ts" });
    expect(paths(text)).toEqual(["sub/AGENTS.md", "sub/a/CLAUDE.md"]);
    expect(text).toContain("sub rules");
    expect(text).not.toContain("root rules");
    expect(text).not.toContain("above cwd");
  });

  it("takes the first of AGENTS.override.md, AGENTS.md, CLAUDE.md per directory", async () => {
    put("proj/sub/AGENTS.override.md", "override wins");
    put("proj/sub/CLAUDE.md", "claude loses");
    const text = await run("edit", { path: join(cwd, "sub/y.ts") });
    expect(paths(text)).toEqual(["sub/AGENTS.override.md"]);
    expect(text).not.toContain("sub rules");
  });

  it("covers ls, grep and find on directories, and grep on a file", async () => {
    expect(paths(await run("ls", { path: "sub" }))).toEqual(["sub/AGENTS.md"]);
    await fresh();
    expect(paths(await run("grep", { pattern: "x", path: "sub/a" }))).toEqual(["sub/AGENTS.md", "sub/a/CLAUDE.md"]);
    await fresh();
    expect(paths(await run("find", { pattern: "*.ts", path: "sub/a/x.ts" }))).toEqual(["sub/AGENTS.md", "sub/a/CLAUDE.md"]);
    await fresh();
    expect(await run("ls", {})).toBe("");
  });

  it("ignores paths outside cwd, a symlink out of cwd, and a symlinked AGENTS.md pointing outside", async () => {
    expect(await run("read", { path: "../outside/z.ts" })).toBe("");
    expect(await run("read", { path: join(root, "outside/z.ts") })).toBe("");
    symlinkSync(join(root, "outside"), join(cwd, "link"));
    expect(await run("read", { path: "link/z.ts" })).toBe("");
    put("proj/evil/f.ts", "f");
    symlinkSync(join(root, "outside/AGENTS.md"), join(cwd, "evil/AGENTS.md"));
    put("proj/evil/CLAUDE.md", "no fallback");
    expect(await run("read", { path: "evil/f.ts" })).toBe("");
  });

  it("stays off with --no-context-files", async () => {
    pi = fakePi();
    nested(pi.pi, { argv: ["node", "pi", "--no-context-files"] });
    expect(await run("read", { path: "sub/y.ts" })).toBe("");
  });

  it("skips node_modules and failed calls", async () => {
    put("proj/node_modules/pkg/AGENTS.md", "third party");
    put("proj/node_modules/pkg/i.js", "i");
    expect(await run("read", { path: "node_modules/pkg/i.js" })).toBe("");
    expect(await run("read", { path: "sub/y.ts" }, { isError: true })).toBe("");
  });

  it("loads path-scoped rules for matching files only", async () => {
    put("proj/.claude/rules/ts.md", "---\npaths:\n  - \"sub/**/*.ts\"\n---\nts rule body");
    put("proj/.agents/rules/always.md", "no paths: not loaded on demand");
    put("proj/sub/readme.txt", "r");
    const text = await run("read", { path: "sub/a/x.ts" });
    expect(paths(text)).toEqual([".claude/rules/ts.md", "sub/AGENTS.md", "sub/a/CLAUDE.md"]);
    expect(text).toContain("ts rule body");
    expect(text).not.toContain("paths:");
    expect(paths(await run("read", { path: "sub/readme.txt" }))).toEqual([]);
  });
});

describe("bash", () => {
  const touches = (cmd: string) => bashTouches(cmd, "/w/p", "/home/u").map((t) => `${t.kind}:${t.path}`);
  it("reads a leading cd and single-file cat/head", () => {
    expect(touches("cd sub && npm test")).toEqual(["dir:/w/p/sub"]);
    expect(touches("cd sub; ls")).toEqual(["dir:/w/p/sub"]);
    expect(touches("cd sub && cat a/x.ts")).toEqual(["dir:/w/p/sub", "file:/w/p/sub/a/x.ts"]);
    expect(touches("head -n 5 sub/y.ts")).toEqual(["file:/w/p/sub/y.ts"]);
    expect(touches("cat sub/y.ts | grep x")).toEqual(["file:/w/p/sub/y.ts"]);
  });
  it("ignores a later cd, several files, and dynamic words", () => {
    expect(touches("npm test; cd sub")).toEqual([]);
    expect(touches("cat a.ts b.ts")).toEqual([]);
    expect(touches("cat $F")).toEqual([]);
    expect(touches("cd $D && ls")).toEqual([]);
    expect(touches("echo $(cat sub/y.ts)")).toEqual([]);
  });
  it("injects for a cd prefix through the extension", async () => {
    expect(paths(await run("bash", { command: "cd sub/a && npm test" }))).toEqual(["sub/AGENTS.md", "sub/a/CLAUDE.md"]);
  });
});

describe("ledger", () => {
  it("injects each file once per context", async () => {
    expect(paths(await run("read", { path: "sub/y.ts" }))).toEqual(["sub/AGENTS.md"]);
    expect(await run("read", { path: "sub/y.ts" })).toBe("");
    expect(paths(await run("read", { path: "sub/a/x.ts" }))).toEqual(["sub/a/CLAUDE.md"]);
  });

  it("re-injects after a compaction that dropped the result, not after one that kept it", async () => {
    const before = branch.entries.length;
    await run("read", { path: "sub/y.ts" });
    const injectedCall = branch.entries[before]!;
    // Kept: the compaction keeps entries from the injected call on.
    branch.compact(injectedCall.id);
    expect(await run("read", { path: "sub/y.ts" })).toBe("");
    // Dropped: a later compaction keeps only what comes after.
    const keep = branch.user("after");
    branch.compact(keep.id);
    expect(paths(await run("read", { path: "sub/y.ts" }))).toEqual(["sub/AGENTS.md"]);
  });

  it("follows the branch, so /tree to a point before the injection loads it again", async () => {
    await run("read", { path: "sub/y.ts" });
    expect(await run("read", { path: "sub/y.ts" })).toBe("");
    branch.entries = branch.entries.slice(0, 1);
    await pi.emit("session_tree", {}, ctx());
    expect(paths(await run("read", { path: "sub/y.ts" }))).toEqual(["sub/AGENTS.md"]);
  });

  it("re-injects when the file changes", async () => {
    await run("read", { path: "sub/y.ts" });
    put("proj/sub/AGENTS.md", "sub rules, edited");
    const text = await run("read", { path: "sub/y.ts" });
    expect(text).toContain("sub rules, edited");
  });

  it("counts parallel calls that aren't in the session yet", async () => {
    expect(paths(await run("read", { path: "sub/y.ts" }, { persist: false }))).toEqual(["sub/AGENTS.md"]);
    expect(await run("read", { path: "sub/a/x.ts" }, { persist: false })).not.toContain("sub rules");
  });

  it("skips a file the model read itself", async () => {
    expect(paths(await run("read", { path: "sub/AGENTS.md" }))).toEqual([]);
    expect(await run("read", { path: "sub/y.ts" })).toBe("");
    // A partial read doesn't count: the whole file is appended to it.
    await fresh();
    expect(paths(await run("read", { path: "sub/AGENTS.md", offset: 2 }))).toEqual(["sub/AGENTS.md"]);
  });

  it("ignores a file that only quotes the tag", async () => {
    const id = "quoted";
    branch.call(id, "read", { path: "notes.md" });
    branch.result(id, "read", [{ type: "text", text: 'see <nested-instructions path="sub/AGENTS.md">\nsub rules\n</nested-instructions>' }]);
    expect(paths(await run("read", { path: "sub/y.ts" }))).toEqual(["sub/AGENTS.md"]);
  });
});

describe("caps, comments, trust", () => {
  it("caps a file at 32 KiB with a marker", async () => {
    put("proj/sub/AGENTS.md", "line of instructions\n".repeat(3000));
    const [b] = parseBlocks(await run("read", { path: "sub/y.ts" }));
    expect(Buffer.byteLength(b!.body)).toBeLessThan(FILE_CAP + 300);
    expect(b!.body).toMatch(/\[truncated: showing the first 32 KiB of sub\/AGENTS\.md \(63000 bytes\)/);
  });

  it("keeps a tool result near 64 KiB: later files become pointers", async () => {
    const big = "x".repeat(30 * 1024);
    put("proj/sub/AGENTS.md", big);
    put("proj/sub/a/CLAUDE.md", big);
    put("proj/sub/a/b/AGENTS.md", big);
    put("proj/sub/a/b/f.ts", "f");
    const text = await run("read", { path: "sub/a/b/f.ts" });
    const blocks = parseBlocks(text);
    expect(blocks.map((b) => b.key)).toEqual(["sub/AGENTS.md", "sub/a/CLAUDE.md", "sub/a/b/AGENTS.md"]);
    expect(blocks[2]!.body).toContain("budget is used up");
    expect(Buffer.byteLength(text)).toBeLessThan(RESULT_CAP + 1024);
  });

  it("strips HTML comments outside code fences", () => {
    expect(stripHtmlComments("a <!-- hidden --> b\n<!--\nmulti\n-->\n```\n<!-- kept -->\n```")).toBe("a  b\n\n```\n<!-- kept -->\n```");
  });

  it("gives an untrusted project a pointer only", async () => {
    trusted = false;
    const [b] = parseBlocks(await run("read", { path: "sub/y.ts" }));
    expect(b!.key).toBe("sub/AGENTS.md");
    expect(b!.body).toContain("isn't trusted");
    expect(b!.body).not.toContain("sub rules");
  });
});
