import { describe, expect, it } from "vitest";
import { groupMessages, summarizeSteps, type Msg } from "../../src/tui/steps.js";

const ok = { isError: false };

describe("summarizeSteps", () => {
  it("counts files once per path but commands and searches per call", () => {
    const s = summarizeSteps([
      { tool: "read", args: { path: "a.ts" }, result: ok },
      { tool: "read", args: { path: "a.ts" }, result: ok },
      { tool: "read", args: { path: "b.ts" }, result: ok },
      { tool: "bash", args: { command: "npm test" }, result: ok },
      { tool: "bash", args: { command: "npm test" }, result: ok },
      { tool: "grep", args: { pattern: "x" }, result: ok },
    ]);
    expect(s.text).toBe("Read 2 files, ran 2 commands, ran 1 search");
  });

  it("sums edit patch lines and write content lines into one edited bucket", () => {
    const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx";
    const s = summarizeSteps([
      { tool: "edit", args: { path: "a.ts" }, result: { isError: false, details: { patch } } },
      { tool: "write", args: { path: "b.ts", content: "1\n2\n3\n" }, result: ok },
      { tool: "edit", args: { path: "a.ts" }, result: { isError: false, details: { patch: "-x\n+y" } } },
    ]);
    expect(s.text).toBe("Edited 2 files (+6 -2)");
  });

  it("reports failed and running steps, and the running one as current", () => {
    const s = summarizeSteps([
      { tool: "read", args: { path: "gone.txt" }, result: { isError: true } },
      { tool: "edit", args: { path: "a.ts" }, result: { isError: true, details: { patch: "+x" } } },
      { tool: "bash", args: { command: "sleep 5\necho done" } },
    ]);
    expect(s).toMatchObject({ failed: 2, running: 1, current: "bash sleep 5" });
    // A failed edit adds no line counts.
    expect(s.text).toBe("Read 1 file, edited 1 file, ran 1 command");
  });

  it("names b4agent tools instead of \"other tools\"", () => {
    expect(summarizeSteps([{ tool: "exit_spec", args: {}, result: ok }, { tool: "mystery", args: {}, result: ok }]).text).toBe("Presented 1 spec, used mystery");
  });
  it("collapses web and session tools into their own phrases, counting each page once", () => {
    const steps = [
      { tool: "web_search", args: { query: "pi 1.3 changelog" }, result: ok },
      { tool: "web_search", args: { query: "pi extensions" }, result: ok },
      { tool: "web_fetch", args: { url: "https://pi.dev/a" }, result: ok },
      { tool: "web_fetch", args: { url: "https://pi.dev/a", offset: 30000 }, result: ok },
      { tool: "web_fetch", args: { url: "https://pi.dev/b" }, result: ok },
      { tool: "session_read", args: { session: "01a0" }, result: ok },
      { tool: "mcp_github_search", args: {}, result: ok },
      { tool: "mcp_github_search", args: {}, result: ok },
    ];
    expect(summarizeSteps(steps).text).toBe("Ran 2 web searches, fetched 2 pages, read 1 past session, used mcp_github_search ×2");
  });
});

const call = (id: string, name: string, args: Record<string, unknown>, text?: string): Msg => ({
  role: "assistant",
  stopReason: "toolUse",
  content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, isError = false): Msg => ({ role: "toolResult", toolCallId: id, isError, content: [] });
const text = (t: string, stopReason = "stop"): Msg => ({ role: "assistant", stopReason, content: [{ type: "text", text: t }] });
const user = (t: string): Msg => ({ role: "user", content: t });

describe("groupMessages", () => {
  it("folds narration between calls but keeps the answer after the last call outside", () => {
    const blocks = groupMessages([
      user("go"),
      call("1", "bash", { command: "ls" }, "looking"),
      result("1"),
      text("between"),
      call("2", "read", { path: "a" }),
      result("2", true),
      text("final answer"),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["message", "steps", "message"]);
    const steps = blocks[1]!;
    if (steps.kind !== "steps") throw new Error();
    expect(steps.messages).toHaveLength(5);
    expect(steps.steps.map((s) => [s.tool, s.result?.isError])).toEqual([["bash", false], ["read", true]]);
    expect(blocks[2]).toMatchObject({ message: { content: [{ text: "final answer" }] } });
  });

  it("keeps an error message outside and splits the run around it", () => {
    const blocks = groupMessages([
      call("1", "bash", { command: "a" }),
      result("1"),
      text("boom", "error"),
      call("2", "bash", { command: "b" }),
      user("next"),
      call("3", "bash", { command: "c" }),
      result("3"),
    ]);
    expect(blocks.map((b) => (b.kind === "steps" ? `steps:${b.steps.length}` : b.message.role))).toEqual([
      "steps:1",
      "assistant",
      "steps:1",
      "user",
      "steps:1",
    ]);
    const second = blocks[2]!;
    // The call without a result yet is still running.
    expect(second.kind === "steps" && second.steps[0]!.result).toBeUndefined();
  });

  it("leaves a turn without tool calls ungrouped", () => {
    expect(groupMessages([user("hi"), text("hello")]).map((b) => b.kind)).toEqual(["message", "message"]);
  });
});
