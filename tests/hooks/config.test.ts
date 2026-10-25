import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hookToolName, ifAllows, loadHooks, matches, select, toolAliases, type CommandHook } from "../../src/hooks/config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "b4-hooks-config-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const hook = (event: CommandHook["event"], matcher: string, command = "true", extra: Partial<CommandHook> = {}): CommandHook => ({ event, matcher, command, source: "global", file: "g", ...extra });

describe("matchers (Claude Code's rules)", () => {
  it.each([
    ["", ["Bash"], true],
    ["*", ["anything"], true],
    ["Bash", ["Bash"], true],
    ["Bash", ["BashOutput"], false], // exact, not a prefix
    ["Edit|Write", ["Write"], true],
    ["Edit, Write", ["Edit"], true],
    ["Edit.*", ["NotebookEdit"], true], // a regex is unanchored, as the docs warn
    ["Edit.*", ["Edit"], true],
    ["^Edit$", ["NotebookEdit"], false],
    ["mcp__memory__.*", ["mcp__memory__save"], true],
    ["startup|resume", ["compact"], false],
    ["(", ["("], false], // a bad regex matches nothing
  ])("%s against %j → %s", (m, values, want) => {
    expect(matches(m, values)).toBe(want);
  });

  it("maps Claude Code's tool names onto Pi's and keeps Pi's names working", () => {
    expect(hookToolName("bash")).toBe("Bash");
    expect(hookToolName("find")).toBe("Glob");
    expect(hookToolName("web_fetch")).toBe("WebFetch");
    expect(hookToolName("my_tool")).toBe("my_tool");
    expect(toolAliases("agent")).toEqual(["agent", "Agent", "Task"]);
    const hs = [hook("PreToolUse", "Bash", "a"), hook("PreToolUse", "bash", "b"), hook("PreToolUse", "Glob", "c"), hook("PreToolUse", "Edit|Write", "d"), hook("PreToolUse", "^Re", "e")];
    expect(select(hs, "PreToolUse", "bash").map((h) => h.command)).toEqual(["a", "b"]);
    expect(select(hs, "PreToolUse", "find").map((h) => h.command)).toEqual(["c"]);
    expect(select(hs, "PreToolUse", "write").map((h) => h.command)).toEqual(["d"]);
    expect(select(hs, "PreToolUse", "read").map((h) => h.command)).toEqual(["e"]);
    expect(select(hs, "PostToolUse", "bash")).toEqual([]);
  });

  it("ignores the matcher where Claude Code does, and runs a command defined twice once", () => {
    const hs = [hook("Stop", "never-matches"), hook("UserPromptSubmit", "x", "p"), hook("SessionStart", "startup", "s"), hook("SessionStart", "*", "s")];
    expect(select(hs, "Stop", undefined)).toHaveLength(1);
    expect(select(hs, "UserPromptSubmit", undefined)).toHaveLength(1);
    expect(select(hs, "SessionStart", "startup")).toHaveLength(1);
    expect(select(hs, "SessionStart", "compact")).toHaveLength(1);
  });
});

describe("if", () => {
  const cwd = "/work/proj";
  const bash = (command: string) => ({ name: "bash", input: { command } });
  it.each([
    ["Bash(git *)", "FOO=bar git push", true],
    ["Bash(git *)", "npm test && git push", true],
    ["Bash(rm *)", "echo $(rm -rf /)", true],
    ["Bash(rm *)", "echo $(date)", false],
    ["Bash(rm *)", "npm test", false],
    ["Bash(git push *)", "$CMD", true], // more than the command name: runs when the command can't be known
    ["Bash(npm run test:*)", "npm run test:unit", true],
    ["Bash", "anything", true],
    ["Edit(*.ts)", "x", false], // wrong tool
  ])("%s with %s → %s", (rule, command, want) => {
    expect(ifAllows(rule, "PreToolUse", bash(command), cwd, cwd)).toBe(want);
  });

  it("matches file paths and never runs on non-tool events", () => {
    const edit = (path: string) => ({ name: "edit", input: { path } });
    expect(ifAllows("Edit(*.ts)", "PreToolUse", edit("src/deep/a.ts"), cwd, cwd)).toBe(true);
    expect(ifAllows("Edit(*.ts)", "PreToolUse", edit("src/a.js"), cwd, cwd)).toBe(false);
    expect(ifAllows("Edit(src/**)", "PreToolUse", edit("/work/proj/src/x/y.md"), cwd, cwd)).toBe(true);
    expect(ifAllows("Edit(src/**)", "PreToolUse", edit("lib/y.md"), cwd, cwd)).toBe(false);
    expect(ifAllows("Write(//etc/**)", "PostToolUse", { name: "write", input: { path: "/etc/hosts" } }, cwd, cwd)).toBe(true);
    expect(ifAllows("Bash(git *)", "Stop", undefined, cwd, cwd)).toBe(false);
  });
});

describe("loading", () => {
  const write = (p: string, v: unknown) => {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify(v));
  };
  const g = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "global.sh", timeout: 5 }] }] } };
  const p = {
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "project.sh", args: ["${CLAUDE_PROJECT_DIR}/x"], if: "Edit(*.ts)", onFailure: "block" }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: "x" }] }],
      Stop: [{ hooks: [{ type: "prompt", prompt: "done?" }, { type: "command", command: "bg.sh", async: true }] }],
    },
  };

  it("reads global hooks and, in a trusted project, the project's .pi/b4agent.json", () => {
    write(join(root, "home", "b4agent.json"), g);
    write(join(root, "proj", ".pi", "b4agent.json"), p);
    const cfg = loadHooks(join(root, "home"), join(root, "proj"), true);
    expect(cfg.hooks.map((h) => [h.event, h.source, h.command])).toEqual([["PreToolUse", "global", "global.sh"], ["PostToolUse", "project", "project.sh"]]);
    expect(cfg.hooks[0]!.timeout).toBe(5);
    expect(cfg.hooks[1]).toMatchObject({ args: ["${CLAUDE_PROJECT_DIR}/x"], if: "Edit(*.ts)", onFailure: "block" });
    expect(cfg.skipped.map((s) => s.why)).toEqual(["event not supported by b4agent", '"prompt" hooks are not supported; only "command"', "async hooks are not supported"]);
  });

  it("ignores project hooks in an untrusted project and says so", () => {
    write(join(root, "home", "b4agent.json"), g);
    write(join(root, "proj", ".pi", "b4agent.json"), p);
    const cfg = loadHooks(join(root, "home"), join(root, "proj"), false);
    expect(cfg.hooks.map((h) => h.source)).toEqual(["global"]);
    expect(cfg.projectHooksIgnored).toBe(true);
  });

  it("honors disableAllHooks and reports bad files", () => {
    write(join(root, "home", "b4agent.json"), { ...g, disableAllHooks: true });
    write(join(root, "proj", ".pi", "b4agent.json"), p);
    expect(loadHooks(join(root, "home"), join(root, "proj"), true).hooks).toEqual([]);
    writeFileSync(join(root, "home", "b4agent.json"), "{ nope");
    expect(loadHooks(join(root, "home"), undefined, true).errors[0]).toMatch(/could not parse/);
  });
});
