import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import memory from "../../src/extension/memory.js";
import { MAX_BYTES, memoryStores, truncateIndex } from "../../src/memory/store.js";
import { projectDir } from "../../src/checkpoints/store.js";
import { classifyToolCall } from "../../src/permissions/rules/tools.js";
import { fakePi } from "../context/fake-pi.js";

let root: string;
let home: string;
let cwd: string;
const saved = process.env.B4AGENT_HOME;

const put = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { stdio: "ignore" });

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "b4-memory-")));
  home = join(root, "home");
  cwd = join(root, "repo");
  mkdirSync(cwd, { recursive: true });
  git(cwd, "init", "-q", "-b", "main");
  writeFileSync(join(cwd, "f"), "f");
  git(cwd, "add", ".");
  git(cwd, "commit", "-qm", "init");
  process.env.B4AGENT_HOME = home;
});
afterEach(() => {
  if (saved === undefined) delete process.env.B4AGENT_HOME;
  else process.env.B4AGENT_HOME = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("stores", () => {
  it("puts global memory in B4AGENT_HOME and project memory in the checkpoint store's project folder", () => {
    const [g, p] = memoryStores(home, cwd);
    expect(g.index).toBe(join(home, "memory", "MEMORY.md"));
    expect(p.dir).toBe(join(projectDir(home, cwd), "memory"));
    expect(p.dir).toMatch(/\/projects\/repo-[0-9a-f]{12}\/memory$/);
  });

  it("shares project memory between a repository's worktrees and subfolders", () => {
    const wt = join(root, "wt");
    git(cwd, "worktree", "add", "-q", wt, "-b", "side");
    mkdirSync(join(cwd, "sub"));
    const main = memoryStores(home, cwd)[1].dir;
    expect(memoryStores(home, wt)[1].dir).toBe(main);
    expect(memoryStores(home, join(cwd, "sub"))[1].dir).toBe(main);
  });

  it("lets the permission gate allow writes to both stores without asking", () => {
    const ctx = { cwd, workspace: cwd, home: root, b4agentDir: home };
    for (const s of memoryStores(home, cwd)) {
      expect(classifyToolCall("write", { path: join(s.dir, "feedback_testing.md"), content: "x" }, ctx)).toMatchObject({ level: "allow", rule: "b4agent-home" });
      expect(classifyToolCall("edit", { path: s.index }, ctx)).toMatchObject({ level: "allow", rule: "b4agent-home" });
    }
  });
});

describe("index truncation", () => {
  it("keeps the first 200 lines and points at the full file", () => {
    const raw = Array.from({ length: 250 }, (_, i) => `- line ${i + 1}`).join("\n");
    const { text, truncated } = truncateIndex(raw, "/m/MEMORY.md");
    expect(truncated).toBe(true);
    expect(text).toContain("- line 200\n");
    expect(text).not.toContain("- line 201");
    expect(text).toContain("The full file is at /m/MEMORY.md; read it with read.");
  });

  it("stops at 25 KB on a whole line", () => {
    const raw = Array.from({ length: 150 }, (_, i) => `- ${String(i).padStart(3, "0")} ${"é".repeat(150)}`).join("\n");
    const { text } = truncateIndex(raw, "/m/MEMORY.md");
    const kept = text.slice(0, text.indexOf("\n\n[MEMORY.md is truncated"));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAX_BYTES);
    expect(kept.split("\n").every((l) => l.endsWith("é".repeat(150)))).toBe(true);
  });

  it("cuts an oversized single line at a character boundary", () => {
    const { text } = truncateIndex("é".repeat(20_000), "/m/MEMORY.md");
    const kept = text.slice(0, text.indexOf("\n\n[MEMORY.md"));
    expect(kept).toMatch(/^é+$/);
    expect(Buffer.byteLength(kept)).toBeLessThan(MAX_BYTES);
  });

  it("leaves a short index alone", () => {
    expect(truncateIndex("- a\n- b\n", "/m/MEMORY.md")).toEqual({ text: "- a\n- b", truncated: false });
  });
});

describe("the memory section", () => {
  const ctx = () => ({ cwd, hasUI: false, ui: { notify: (m: string) => notes.push(m) } });
  let notes: string[] = [];
  const turn = async (pi: ReturnType<typeof fakePi>) => {
    const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
    await pi.emit("before_agent_start", event, ctx());
    return event.systemPromptOptions.sections.memory;
  };

  it("is byte-stable across turns while memory changes, and picks changes up after compaction or a reload", async () => {
    const [g, p] = memoryStores(home, cwd);
    put(g.index, "- [Prefers pnpm](user_pnpm.md): use pnpm, never npm\n");
    const pi = fakePi();
    memory(pi.pi);
    await pi.emit("session_start", { reason: "startup" }, ctx());
    const first = await turn(pi);
    expect(first).toContain("use pnpm, never npm");
    expect(first).toContain(`<memory_index scope="project" path="${p.index}">\n(empty)`);
    expect(first).toContain("Save a memory when");
    expect(first).toContain("Don't save secrets");

    put(p.index, "- [Staging](project_staging.md): staging is staging.example\n");
    expect(await turn(pi)).toBe(first);
    expect(await turn(pi)).toBe(first);

    await pi.emit("session_compact", {}, ctx());
    const afterCompact = await turn(pi);
    expect(afterCompact).toContain("staging is staging.example");

    put(g.index, "- changed\n");
    expect(await turn(pi)).toBe(afterCompact);
    await pi.emit("session_start", { reason: "reload" }, ctx());
    expect(await turn(pi)).toContain("- changed");
  });

  it("is read-only for subagents, and absent when both stores are empty", async () => {
    const child = fakePi();
    memory(child.pi, { child: true });
    await child.emit("session_start", { reason: "startup" }, ctx());
    expect(await turn(child)).toBeUndefined();

    const [g] = memoryStores(home, cwd);
    put(g.index, "- [Prefers pnpm](user_pnpm.md): use pnpm\n");
    await child.emit("session_start", { reason: "startup" }, ctx());
    const s = await turn(child);
    expect(s).toContain("use pnpm");
    expect(s).toContain("read-only for subagents");
    expect(s).not.toContain("Save a memory");

    const call = (path: string) => child.emit("tool_call", { toolName: "write", input: { path, content: "x" } }, ctx());
    expect(await call(join(g.dir, "user_new.md"))).toMatchObject({ block: true });
    expect(await call(join(cwd, "src.ts"))).toBeUndefined();
  });

  it("blocks a subagent's bash writes into the stores, reads and the main agent untouched", async () => {
    // ~ and $HOME are what bash expands, so the stores sit under HOME here.
    const savedHome = process.env.HOME;
    process.env.HOME = root;
    process.env.B4AGENT_HOME = join(root, ".b4agent");
    try {
      const [g, p] = memoryStores(join(root, ".b4agent"), cwd);
      put(g.index, "- a\n");
      const child = fakePi();
      memory(child.pi, { child: true });
      await child.emit("session_start", { reason: "startup" }, ctx());
      const bash = (command: string, pi = child) => pi.emit("tool_call", { toolName: "bash", input: { command } }, ctx());

      const blocked = await bash("echo x >> ~/.b4agent/memory/MEMORY.md");
      expect(blocked).toMatchObject({ block: true });
      expect((blocked as { reason: string }).reason).toContain(g.index);
      expect((blocked as { reason: string }).reason).toContain("main agent will save it");
      // Variables the gate tracks (assigned in the command, inherited, a for list), cd, tee, cp and rm all resolve to the store.
      expect(await bash('M=~/.b4agent/memory; echo x > "$M/user_x.md"')).toMatchObject({ block: true });
      expect(await bash('echo x >> "$HOME/.b4agent/memory/MEMORY.md"')).toMatchObject({ block: true });
      expect(await bash("for f in ~/.b4agent/memory/a.md; do echo x > $f; done")).toMatchObject({ block: true });
      expect(await bash(`echo x | tee -a ${p.index}`)).toMatchObject({ block: true });
      expect(await bash("cd ~/.b4agent/memory && printf x > user_y.md")).toMatchObject({ block: true });
      expect(await bash(`cp /tmp/x ${p.dir}/`)).toMatchObject({ block: true });
      expect(await bash("rm ~/.b4agent/memory/*.md")).toMatchObject({ block: true });
      // Reads, and writes elsewhere, pass (the gate decides those).
      expect(await bash("cat ~/.b4agent/memory/MEMORY.md")).toBeUndefined();
      expect(await bash(`grep -r pnpm ${p.dir} > /tmp/out.txt`)).toBeUndefined();
      expect(await bash('M=~/.b4agent/memory; cat "$M/MEMORY.md" > notes.md')).toBeUndefined();
      expect(await bash("echo x >> ~/.b4agent/specs/plan.md")).toBeUndefined();

      const main = fakePi();
      memory(main.pi);
      await main.emit("session_start", { reason: "startup" }, ctx());
      expect(await bash("echo x >> ~/.b4agent/memory/MEMORY.md", main)).toBeUndefined();
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("lists the stores with /memory", async () => {
    notes = [];
    const pi = fakePi();
    memory(pi.pi);
    const [g, p] = memoryStores(home, cwd);
    put(g.index, "- a\n- b\n");
    put(join(g.dir, "user_a.md"), "a");
    await pi.commands.get("memory")!.handler("", ctx());
    expect(notes[0]).toContain(`global: ${g.dir}/\n  MEMORY.md, 2 lines · 1 topic file`);
    expect(notes[0]).toContain(`project: ${p.dir}/\n  no MEMORY.md yet · 0 topic files`);
  });
});
