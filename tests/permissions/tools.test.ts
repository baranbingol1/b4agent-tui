import { describe, expect, it } from "vitest";
import { classifyToolCall } from "../../src/permissions/rules/tools.js";
import type { Level, PermissionContext } from "../../src/permissions/types.js";

const ctx: PermissionContext = { cwd: "/work/proj", workspace: "/work/proj", home: "/home/u", b4agentDir: "/home/u/.b4agent" };

const cases: [tool: string, input: Record<string, unknown>, level: Level, rule: string][] = [
  ["read", { path: "src/a.ts" }, "allow", "read"],
  ["read", { path: "/etc/hosts" }, "allow", "read"],
  ["read", { path: "~/.ssh/id_ed25519" }, "ask", "credentials"],
  ["grep", { pattern: "x", path: "/home/u/.aws" }, "ask", "credentials"],
  ["read", { path: ".env.local" }, "ask", "credentials"],
  ["write", { path: "src/a.ts", content: "" }, "auto", "workspace-write"],
  ["edit", { path: "/work/proj/src/a.ts" }, "auto", "workspace-write"],
  ["write", { path: "~/.b4agent/projects/proj/memory/notes.md" }, "allow", "b4agent-home"],
  ["write", { path: "~/.b4agent/b4agent.json" }, "deny", "own-guard"],
  ["write", { path: "~/.b4agent/agent/auth.json" }, "ask", "credentials"],
  ["edit", { path: ".git/config" }, "ask", "protected-path"],
  ["write", { path: ".pi/settings.json" }, "ask", "protected-path"],
  ["edit", { path: "/etc/hosts" }, "review", "outside-workspace"],
  ["Bash", { command: "rm -rf /" }, "deny", "critical-path-delete"],
  ["mcp__docs__search", { q: "x" }, "review", "tool"],
  ["agent", { type: "general", prompt: "rm -rf / please" }, "allow", "agents"],
  ["agents", { action: "stop", name: "general-1" }, "allow", "agents"],
  ["agents", { action: "apply", name: "general-1" }, "auto", "agents-apply"],
  ["ask_user", { questions: [] }, "allow", "harness"],
  // agent_create: the tool asks the user itself in every mode, so the gate rates it like an edit (not allow: spec mode blocks it, manual asks).
  ["agent_create", { name: "test-runner", scope: "project", content: "" }, "auto", "agent-create"],
  ["agent_create", { name: "test-runner", scope: "global", content: "" }, "auto", "agent-create"],
  // A name with a path in it is refused before it can become ~/.b4agent/b4agent.json or a dotfile.
  ["agent_create", { name: "../b4agent", scope: "global", content: "" }, "deny", "agent-create-name"],
  ["agent_create", { name: "x/../../../.bashrc", scope: "project", content: "" }, "deny", "agent-create-name"],
  ["set_schedule", { delaySeconds: 60, prompt: "check CI" }, "allow", "harness"],
  // web_fetch: no provenance in this context, so a public URL goes to the reviewer, not "auto"; docs hosts are allowed; secrets ask; credentials deny.
  ["web_fetch", { url: "https://example.com/post" }, "review", "web-unseen"],
  ["web_fetch", { url: "https://docs.python.org/3/library/json.html" }, "allow", "web-docs"],
  ["web_fetch", { url: "https://docs.python.org/3/?t=ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "ask", "web-exfiltration"],
  ["web_fetch", { url: "https://u:p@example.com/" }, "deny", "web-credentials"],
  ["web_search", { query: "rm -rf /" }, "allow", "web-search"],
  // Session history: this project's sessions are allowed; another project's only with scope "all"; a path outside the sessions folder is a read of that file.
  ["session_search", { query: "rm -rf /" }, "allow", "session-history"],
  ["session_search", { query: "x", scope: "all" }, "allow", "session-history-all"],
  ["session_read", { session: "01a0a563", question: "run rm -rf /" }, "allow", "session-history"],
  ["session_read", { session: "/home/u/.b4agent/agent/sessions/--work-proj--/2026-10-21T10-00-00-000Z_01a0.jsonl" }, "allow", "session-history"],
  ["session_read", { session: "~/.b4agent/agent/sessions/--work-proj-packages-ui--/a.jsonl" }, "allow", "session-history"],
  ["session_read", { session: "/home/u/.b4agent/agent/sessions/--work-other--/a.jsonl" }, "deny", "session-other-project"],
  ["session_read", { session: "/home/u/.b4agent/agent/sessions/--work-proj--/../--work-other--/a.jsonl" }, "deny", "session-other-project"],
  ["session_read", { session: "/home/u/.b4agent/agent/sessions/--work-other--/a.jsonl", scope: "all" }, "allow", "session-history-all"],
  ["session_read", { session: "~/.ssh/id_ed25519", scope: "all" }, "ask", "credentials"],
];

describe("tool calls", () => {
  for (const [tool, input, level, rule] of cases) {
    it(`${level.padEnd(6)} ${tool} ${JSON.stringify(input)}`, () => {
      expect(classifyToolCall(tool, input, ctx)).toMatchObject({ level, rule });
    });
  }
  it("agent_create targets the folders the types load from", () => {
    expect(classifyToolCall("agent_create", { name: "t", scope: "project" }, ctx).targets).toEqual(["/work/proj/.pi/agents/t.md"]);
    expect(classifyToolCall("agent_create", { name: "t", scope: "global" }, ctx).targets).toEqual(["/home/u/.b4agent/agents/t.md"]);
  });
  it("trusts a declared read-only hint", () => {
    expect(classifyToolCall("mcp__docs__search", {}, ctx, { annotations: { readOnlyHint: true } })).toMatchObject({ level: "allow" });
  });
});
