import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandHook } from "../../src/hooks/config.js";
import { decide } from "../../src/hooks/decide.js";
import { outcomeOf, parseStdout, runAll, runHook } from "../../src/hooks/run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "b4-hooks-run-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const hook = (command: string, extra: Partial<CommandHook> = {}): CommandHook => ({ event: "PreToolUse", matcher: "", command, source: "global", file: "g", ...extra });
const opts = () => ({ cwd: dir, projectDir: "/the/project" });
const run = async (command: string, extra: Partial<CommandHook> = {}, input: unknown = { x: 1 }) => outcomeOf(await runHook(hook(command, extra), input, opts()));

describe("one command hook", () => {
  it("gets the event as JSON on stdin and both project-dir variables", async () => {
    await run(`cat > in.json; printf '%s|%s' "$CLAUDE_PROJECT_DIR" "$B4AGENT_PROJECT_DIR" > env.txt`, {}, { hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
    expect(JSON.parse(readFileSync(join(dir, "in.json"), "utf8"))).toEqual({ hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
    expect(readFileSync(join(dir, "env.txt"), "utf8")).toBe("/the/project|/the/project");
  });

  it("runs the exec form without a shell, with placeholders substituted", async () => {
    const o = await run("printf", { args: ["%s:%s", "${CLAUDE_PROJECT_DIR}", "$HOME'`x`"] });
    expect(o.text).toBe("/the/project:$HOME'`x`");
  });

  it("exit 2 blocks with stderr; JSON alongside is read but can't undo it", async () => {
    expect(await run("echo 'no rm here' >&2; exit 2")).toMatchObject({ blocking: true, blockReason: "no rm here" });
    const o = await run(`echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'; echo nope >&2; exit 2`);
    expect(decide("PreToolUse", [o])).toMatchObject({ permission: "deny", reason: "nope" });
  });

  it("exit 0 applies JSON; other codes are non-blocking errors unless JSON decides", async () => {
    expect((await run(`echo '{"decision":"block","reason":"r"}'`)).json).toEqual({ decision: "block", reason: "r" });
    expect(await run("echo oops >&2; exit 1")).toMatchObject({ blocking: false, error: "failed with non-blocking status code 1: oops" });
    expect((await run(`echo '{"continue":false}'; exit 3`)).json).toEqual({ continue: false });
    expect(await run("echo '{not json}'")).toMatchObject({ blocking: false, error: expect.stringContaining("invalid JSON output") });
    expect(await run("echo 'plain words'")).toMatchObject({ blocking: false, text: "plain words" });
  });

  it("times out, kills the process group, and gives no decision", async () => {
    const t0 = Date.now();
    const o = await run(`(sleep 5; echo late > late.txt) & sleep 5`, { timeout: 0.3 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(o).toMatchObject({ blocking: false, error: "timed out after 0.3s" });
    await new Promise((r) => setTimeout(r, 300));
    expect(() => readFileSync(join(dir, "late.txt"))).toThrow();
  });

  it("onFailure: block turns a timeout, a missing script or a crash into a block", async () => {
    expect(await run("sleep 5", { timeout: 0.2, onFailure: "block" })).toMatchObject({ blocking: true, blockReason: expect.stringContaining('onFailure is "block"') });
    expect(await run("/nonexistent/hook.sh", { onFailure: "block" })).toMatchObject({ blocking: true });
    expect(await run("/nonexistent/hook.sh")).toMatchObject({ blocking: false, error: expect.stringContaining("127") });
  });

  it("doesn't wait for a background process that keeps stdout open", async () => {
    const t0 = Date.now();
    const o = await run(`echo '{"decision":"block","reason":"x"}'; sleep 5 &`);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(o.json).toEqual({ decision: "block", reason: "x" });
  });
});

describe("several hooks", () => {
  it("run in parallel", async () => {
    const t0 = Date.now();
    const outs = await runAll([hook("sleep 0.6; echo a"), hook("sleep 0.6; echo b"), hook("sleep 0.6; echo c")], {}, opts());
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(outs.map((o) => o.text)).toEqual(["a", "b", "c"]);
  });

  it("PreToolUse precedence is deny > ask > allow; reasons and updatedInput come from the winners", async () => {
    const json = (v: unknown) => `echo '${JSON.stringify(v)}'`;
    const allow = hook(json({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "fine", updatedInput: { command: "ls -la" } } }));
    const ask = hook(json({ hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check", additionalContext: "ctx" } }));
    const deny = hook(json({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "nope" } }));
    const legacy = hook(json({ decision: "approve", reason: "old style" }));
    const d1 = decide("PreToolUse", await runAll([allow, ask], {}, opts()));
    expect(d1).toMatchObject({ permission: "ask", reason: "check", contexts: ["ctx"] });
    expect(d1.updatedInput).toBeUndefined();
    expect(decide("PreToolUse", await runAll([allow, legacy], {}, opts()))).toMatchObject({ permission: "allow", reason: "fine\nold style", updatedInput: { command: "ls -la" } });
    expect(decide("PreToolUse", await runAll([allow, ask, deny], {}, opts()))).toMatchObject({ permission: "deny", reason: "nope" });
  });

  it("per-event outputs: block reasons, plain text as context only where Claude Code adds it, continue:false, systemMessage", async () => {
    const out = (s: string) => runAll([hook(s)], {}, opts());
    expect(decide("Stop", await out(`echo '{"decision":"block","reason":"run the tests"}'`))).toMatchObject({ blocked: "run the tests" });
    expect(decide("Stop", await out("echo 'keep going' >&2; exit 2"))).toMatchObject({ blocked: "keep going" });
    expect(decide("UserPromptSubmit", await out("echo 'branch: main'")).contexts).toEqual(["branch: main"]);
    expect(decide("PostToolUse", await out("echo 'branch: main'")).contexts).toEqual([]);
    expect(decide("PostToolUse", await out(`echo '{"continue":false,"stopReason":"halt","systemMessage":"heads up"}'`))).toMatchObject({ stop: "halt", notices: ["heads up"] });
    // Notification and SessionEnd can't block or stop anything.
    expect(decide("Notification", await out(`echo '{"continue":false}'; exit 2`))).toMatchObject({ notices: [] });
    expect(decide("Notification", await out(`echo '{"continue":false}'; exit 2`)).stop).toBeUndefined();
  });

  it("parses stdout as JSON only when it is one object", () => {
    expect(parseStdout('  {"a":1}\n')).toEqual({ kind: "json", value: { a: 1 } });
    expect(parseStdout("[1]")).toEqual({ kind: "text", text: "[1]" });
    expect(parseStdout('profile line\n{"a":1}')).toEqual({ kind: "text", text: 'profile line\n{"a":1}' });
    writeFileSync(join(dir, "unused"), "");
  });
});
