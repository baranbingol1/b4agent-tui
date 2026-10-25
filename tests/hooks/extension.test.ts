import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hooks from "../../src/extension/hooks.js";
import { createPermissionShared } from "../../src/extension/permissions.js";
import { hookDecisionOf } from "../../src/permissions/hooks.js";
import { fakePi } from "../context/fake-pi.js";

let root: string;
let home: string;
let cwd: string;
let notes: string[];
const saved = { home: process.env.B4AGENT_HOME, agent: process.env.PI_CODING_AGENT_DIR };

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "b4-hooks-ext-")));
  home = join(root, "b4home");
  cwd = join(root, "proj");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  process.env.B4AGENT_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  notes = [];
});
afterEach(() => {
  for (const [k, v] of [["B4AGENT_HOME", saved.home], ["PI_CODING_AGENT_DIR", saved.agent]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A hook script that saves its stdin to `<name>.json` in the temp dir, then runs `body`. */
function script(name: string, body = "exit 0"): string {
  const p = join(root, `${name}.sh`);
  writeFileSync(p, `#!/bin/sh\ncat > "${join(root, name)}.json"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}
const input = (name: string) => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")) as Record<string, any>;
const ran = (name: string) => existsSync(join(root, `${name}.json`));
const configure = (h: Record<string, unknown>, file = join(home, "b4agent.json")) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ hooks: h }));
};
const group = (command: string, matcher?: string, extra: Record<string, unknown> = {}) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, ...extra }] }];

function ctx(over: Record<string, unknown> = {}): any {
  return {
    cwd,
    hasUI: true,
    mode: "tui",
    model: { id: "m1" },
    signal: undefined,
    ui: { notify: (m: string) => notes.push(m), setStatus: () => undefined },
    sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => "/sessions/sess-1.jsonl" },
    isProjectTrusted: () => true,
    abort: vi.fn(),
    ...over,
  };
}

async function start(opts: Parameters<typeof hooks>[1] = {}, c = ctx()) {
  const f = fakePi();
  (f.pi as any).sendMessage = vi.fn();
  hooks(f.pi, { shared: createPermissionShared(), ...opts });
  await f.emit("session_start", { reason: "startup" }, c);
  return f;
}

describe("PreToolUse (tool_call)", () => {
  it("sends Claude Code's input and blocks on exit 2 with stderr the model sees", async () => {
    configure({ PreToolUse: group(script("pre", 'echo "rm is not allowed here" >&2; exit 2'), "Bash", { if: "Bash(rm *)" }) });
    const f = await start();
    const r = await f.emit("tool_call", { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } }, ctx());
    expect(r).toMatchObject({ block: true });
    expect((r as { reason: string }).reason).toMatch(/^PreToolUse:Bash hook \[.*pre\.sh\] blocked this call: rm is not allowed here/);
    expect(input("pre")).toEqual({
      session_id: "sess-1", transcript_path: "/sessions/sess-1.jsonl", cwd, permission_mode: "auto", hook_event_name: "PreToolUse",
      tool_name: "Bash", tool_input: { command: "rm -rf build" }, tool_use_id: "t1",
    });
    rmSync(join(root, "pre.json"));
    // The `if` filter: no rm, no spawn.
    expect(await f.emit("tool_call", { toolName: "bash", toolCallId: "t2", input: { command: "ls" } }, ctx())).toBeUndefined();
    expect(ran("pre")).toBe(false);
  });

  it("passes allow and ask to the gate, rewrites input, and maps file paths and edits to Claude Code's fields", async () => {
    const out = (v: unknown) => script("pre", `echo '${JSON.stringify(v)}'`);
    configure({ PreToolUse: group(out({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "formatter ok", updatedInput: { file_path: join(cwd, "b.ts"), content: "B" } } }), "Write|Edit") });
    const f = await start();
    const ev = { toolName: "write", toolCallId: "t1", input: { path: "a.ts", content: "A" } as Record<string, unknown> };
    expect(await f.emit("tool_call", ev, ctx())).toBeUndefined();
    expect(hookDecisionOf(ev)).toEqual({ decision: "allow", reason: "formatter ok", source: "global" });
    expect(ev.input).toEqual({ path: join(cwd, "b.ts"), content: "B" });
    expect(input("pre").tool_input).toEqual({ path: "a.ts", content: "A", file_path: join(cwd, "a.ts") });

    await f.emit("tool_call", { toolName: "edit", toolCallId: "t2", input: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] } }, ctx());
    expect(input("pre")).toMatchObject({ tool_name: "Edit", tool_input: { file_path: join(cwd, "a.ts"), old_string: "x", new_string: "y", replace_all: false } });
  });

  it("an ask from any hook beats an allow; a timed-out hook gives no decision and the call goes on", async () => {
    configure({
      PreToolUse: [
        ...group(script("a", `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`), "*"),
        ...group(script("b", `echo '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"confirm deploys"}}'`), "bash"),
        ...group("sleep 5", "Glob", { timeout: 0.2 }),
      ],
    });
    const f = await start();
    const ev = { toolName: "bash", toolCallId: "t1", input: { command: "./deploy.sh" } };
    await f.emit("tool_call", ev, ctx());
    expect(hookDecisionOf(ev)).toMatchObject({ decision: "ask", reason: "confirm deploys" });
    const find = { toolName: "find", toolCallId: "t2", input: { pattern: "*.ts" } };
    expect(await f.emit("tool_call", find, ctx())).toBeUndefined();
    expect(notes.some((n) => n.includes("timed out after 0.2s"))).toBe(true);
  });
});

describe("PostToolUse (tool_result)", () => {
  it("adds context and block feedback next to the result; failures go to PostToolUseFailure", async () => {
    configure({
      PreToolUse: group(script("pre", `echo '{"hookSpecificOutput":{"additionalContext":"generated file"}}'`), "Write"),
      PostToolUse: group(script("post", `echo '{"decision":"block","reason":"lint failed","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"run pnpm lint"}}'`), "Write"),
      PostToolUseFailure: group(script("fail"), "Bash"),
    });
    const f = await start();
    await f.emit("tool_call", { toolName: "write", toolCallId: "t1", input: { path: "a.ts", content: "A" } }, ctx());
    await f.emit("tool_execution_start", { toolCallId: "t1" }, ctx());
    const r = (await f.emit("tool_result", { toolName: "write", toolCallId: "t1", input: { path: "a.ts", content: "A" }, content: [{ type: "text", text: "Wrote a.ts" }], isError: false, details: undefined }, ctx())) as { content: { text: string }[] };
    expect(r.content[0]!.text).toBe("Wrote a.ts");
    const added = r.content[1]!.text;
    expect(added).toContain("PreToolUse hook additional context:\ngenerated file");
    expect(added).toContain("PostToolUse:Write hook feedback:\nlint failed");
    expect(added).toContain("<system-reminder>\nPostToolUse hook additional context:\nrun pnpm lint\n</system-reminder>");
    expect(input("post")).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Write", tool_use_id: "t1", tool_response: { output: "Wrote a.ts", filePath: join(cwd, "a.ts") }, duration_ms: expect.any(Number) });

    expect(await f.emit("tool_result", { toolName: "bash", toolCallId: "t2", input: { command: "false" }, content: [{ type: "text", text: "exit 1" }], isError: true, details: undefined }, ctx())).toBeUndefined();
    expect(input("fail")).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", error: "exit 1" });
  });
});

describe("UserPromptSubmit (input)", () => {
  it("blocks a prompt with a reason for the user, or adds context to the run", async () => {
    configure({ UserPromptSubmit: group(script("ups", `case "$(cat "${join(root, "ups.json")}")" in *secret*) echo "no secrets in prompts" >&2; exit 2;; esac; echo "ticket: B4-12"`)) });
    const f = await start();
    expect(await f.emit("input", { text: "my secret is x", source: "interactive" }, ctx())).toEqual({ action: "handled" });
    expect(notes.at(-1)).toBe("Prompt blocked by a UserPromptSubmit hook: no secrets in prompts");
    expect(await f.emit("input", { text: "fix the bug", source: "interactive" }, ctx())).toBeUndefined();
    expect(input("ups")).toMatchObject({ hook_event_name: "UserPromptSubmit", prompt: "fix the bug" });
    const r = (await f.emit("before_agent_start", { messageType: "user", prompt: "fix the bug", systemPromptOptions: { sections: {} } }, ctx())) as { message: { content: string; display: boolean } };
    expect(r.message).toMatchObject({ display: false, content: expect.stringContaining("ticket: B4-12") });
    // Delivered once.
    expect(await f.emit("before_agent_start", { messageType: "user", prompt: "next", systemPromptOptions: { sections: {} } }, ctx())).toBeUndefined();
  });
});

describe("Stop (agent_before_settle)", () => {
  const settle = (f: Awaited<ReturnType<typeof start>>, outcome = "completed") =>
    f.emit("agent_before_settle", { outcome, entries: [], continue: false, context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text: "All done." }] }] } }, ctx());

  it("a block continues the agent once with the reason; stop_hook_active stops the loop", async () => {
    configure({ Stop: group(script("stop", `grep -q '"stop_hook_active":true' "${join(root, "stop.json")}" && exit 0; echo "run the tests first" >&2; exit 2`)) });
    const f = await start();
    const r = await settle(f);
    expect(r).toEqual({ continue: true, entries: [{ type: "custom_message", customType: "b4agent-hook", content: "Stop hook feedback:\nrun the tests first", display: true, details: { event: "Stop" } }] });
    expect(input("stop")).toMatchObject({ hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: "All done.", background_tasks: [], session_crons: [] });
    expect(await settle(f)).toBeUndefined();
    expect(input("stop").stop_hook_active).toBe(true);
    // Not after Esc or an error.
    rmSync(join(root, "stop.json"));
    await settle(f, "aborted");
    expect(ran("stop")).toBe(false);
  });

  it("stops after 8 continuations in a row", async () => {
    configure({ Stop: group(`echo '{"decision":"block","reason":"again"}'`) });
    const f = await start();
    for (let i = 0; i < 8; i++) expect(await settle(f)).toMatchObject({ continue: true });
    expect(await settle(f)).toBeUndefined();
    expect(notes.at(-1)).toContain("8 times in a row");
  });

  it("runs as SubagentStop in a subagent, with its name and type, and tool hooks see them too", async () => {
    configure({ SubagentStop: group(script("sub", `echo '{"decision":"block","reason":"cite sources"}'`), "explore"), PreToolUse: group(script("pre")) });
    const child = { name: "scout", hub: { agents: new Map([["scout", { type: "explore" }]]) } } as any;
    const f = await start({ child });
    const r = (await settle(f)) as { entries: { content: string }[] };
    expect(r.entries[0]!.content).toBe("SubagentStop hook feedback:\ncite sources");
    expect(input("sub")).toMatchObject({ hook_event_name: "SubagentStop", agent_id: "scout", agent_type: "explore", agent_transcript_path: "/sessions/sess-1.jsonl" });
    await f.emit("tool_call", { toolName: "read", toolCallId: "t1", input: { path: "x" } }, ctx());
    expect(input("pre")).toMatchObject({ agent_id: "scout", agent_type: "explore", tool_name: "Read" });
  });
});

describe("session events", () => {
  it("SessionStart output goes in before the first prompt, which waits for it; its source follows how the session started", async () => {
    configure({ SessionStart: group(script("ss", 'sleep 0.3; echo "branch: feat/x"'), "startup|clear") });
    const f = await start();
    const send = (f.pi as any).sendMessage as ReturnType<typeof vi.fn>;
    expect(send).not.toHaveBeenCalled();
    expect(await f.emit("before_agent_start", { messageType: "user", prompt: "hi", systemPromptOptions: { sections: {} } }, ctx())).toBeUndefined();
    expect(send).toHaveBeenCalledWith({ customType: "b4agent-hook", display: false, content: expect.stringContaining("SessionStart hook additional context:\nbranch: feat/x") });
    expect(input("ss")).toMatchObject({ hook_event_name: "SessionStart", source: "startup", model: "m1" });
    await f.emit("session_start", { reason: "new" }, ctx());
    await f.emit("before_agent_start", { messageType: "user", prompt: "hi", systemPromptOptions: { sections: {} } }, ctx());
    expect(input("ss").source).toBe("clear");
  });

  it("PreCompact can cancel compaction; SessionEnd gets 1.5 s unless the hook sets more", async () => {
    configure({ PreCompact: group(script("pc", 'echo "not now" >&2; exit 2'), "manual"), SessionEnd: group(script("se", "sleep 5")) });
    const f = await start();
    expect(await f.emit("session_before_compact", { reason: "manual", customInstructions: "keep the API notes" }, ctx())).toEqual({ cancel: true });
    expect(input("pc")).toMatchObject({ hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "keep the API notes" });
    expect(await f.emit("session_before_compact", { reason: "threshold" }, ctx())).toBeUndefined();
    const t0 = Date.now();
    await f.emit("session_shutdown", { reason: "quit" }, ctx());
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(input("se")).toMatchObject({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
  });

  it("Notification fires for the permission dialog", async () => {
    configure({ Notification: group(script("note"), "permission_prompt") });
    const f = await start();
    await f.emit("ui_prompt_start", { kind: "select", title: "Allow bash?\n\n  rm -rf dist" }, ctx());
    for (let i = 0; i < 50 && !ran("note"); i++) await new Promise((r) => setTimeout(r, 20));
    expect(input("note")).toMatchObject({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "b4agent needs your permission: Allow bash?" });
  });
});

describe("project hooks and trust", () => {
  const project = () => configure({ PreToolUse: group(script("proj", "exit 2"), "Bash") }, join(cwd, ".pi", "b4agent.json"));
  const call = (f: Awaited<ReturnType<typeof start>>) => f.emit("tool_call", { toolName: "bash", toolCallId: "t", input: { command: "ls" } }, ctx());

  it("don't run where Pi doesn't trust the project", async () => {
    project();
    const f = await start({}, ctx({ isProjectTrusted: () => false }));
    expect(await call(f)).toBeUndefined();
    expect(notes.some((n) => n.includes("this project isn't trusted"))).toBe(true);
  });

  it("don't run on Pi's implicit trust (no .pi/settings.json), only after the user trusted the folder", async () => {
    project();
    expect(await call(await start())).toBeUndefined();
    new ProjectTrustStore(join(root, "agent")).set(cwd, true);
    expect(await call(await start())).toMatchObject({ block: true });
  });

  it("/hooks lists what loaded, from where, and what was skipped", async () => {
    configure({ PreToolUse: group("guard.sh", "Bash", { timeout: 5 }), Elicitation: group("x") });
    const f = await start();
    await f.commands.get("hooks")!.handler("", ctx());
    expect(notes.at(-1)).toBe("PreToolUse\n  [global] Bash → guard.sh (timeout 5s)\n\nSkipped:\n  [global] Elicitation: event not supported by b4agent");
  });
});
