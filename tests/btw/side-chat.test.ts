import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Message, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import btw, { BTW_ENTRY, type BtwHandle } from "../../src/extension/btw.js";
import { classifyToolCall } from "../../src/permissions/rules/tools.js";

/**
 * The side chat must send what the main agent's next request would send, with
 * the question appended, so the provider's prompt cache covers everything but
 * the question. A faux provider records every request; the test compares the
 * side chat's request with the main agent's next one, both as Pi's transcript
 * and as the OpenAI Responses `input` Codex sends.
 */
type Call = { context: TranscriptContext; options: SimpleStreamOptions | undefined };
const calls: Call[] = [];
let reply: (c: Call) => ReturnType<typeof fauxAssistantMessage>;
let dir: string;
let session: AgentSession;
let handle: BtwHandle;
let ctx: ExtensionContext;

const lastUserText = (c: Call) => {
  const u = c.context.messages.findLast((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : (u?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "b4-btw-"));
  writeFileSync(join(dir, "notes.txt"), "the deploy target is staging-eu\n");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", reasoning: true }] });
  faux.setResponses(Array.from({ length: 50 }, () => (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
    const c = { context, options };
    calls.push(c);
    return reply(c);
  }));
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noPromptTemplates: true,
    noThemes: true,
    extensionFactories: [
      {
        name: "test",
        factory: (pi) => {
          pi.registerProvider(faux.provider);
          // Another extension rewriting context: the side chat must see the rewritten transcript, as the provider does.
          pi.on("context", (e) => ({
            messages: e.messages.map((m) => (m.role === "user" && Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === "text" ? { ...b, text: b.text + " [ctx]" } : b)) } : m)),
          }));
          pi.on("agent_end", (_e, c) => void (ctx = c));
          handle = btw(pi, { classify: (tool, input, c) => classifyToolCall(tool, input, { cwd: c.cwd, workspace: c.cwd, home: "/nonexistent", b4agentDir: "/nonexistent/.b4agent" }) });
        },
      },
    ],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    model: faux.getModel(),
    thinkingLevel: "high",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  }));
  await session.bindExtensions({ mode: "print", onError: (e) => { throw new Error(String(e.error)); } });
});

afterAll(() => {
  session?.dispose?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("/btw", () => {
  it("sends the main agent's next request prefix with the question appended, and keeps it out of the main conversation", async () => {
    // Main turn: one read, then an answer.
    reply = (c) => (c.context.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage(fauxText("read it")) : fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }));
    await session.prompt("look at notes.txt");
    expect(calls).toHaveLength(2);

    // Side chat: the model lists files (allowed), tries to write and to delete (refused), then answers.
    let step = 0;
    reply = () => {
      step++;
      if (step === 1) return fauxAssistantMessage([fauxToolCall("ls", { path: "." }), fauxToolCall("write", { path: "x.txt", content: "x" }), fauxToolCall("bash", { command: "rm notes.txt" })], { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxText("staging-eu"));
    };
    const turn = await handle.ask(ctx, "which deploy target?");
    expect(turn).toMatchObject({ answer: "staging-eu" });
    // The faux provider simulates a prefix cache per session id: almost all of the side chat's input is a cache hit.
    expect(turn.usage!.cacheRead).toBeGreaterThan(2 * 1400);
    expect(turn.usage!.input).toBeLessThan(400);
    const side = calls.slice(2);
    expect(side).toHaveLength(2);
    expect(existsSync(join(dir, "x.txt"))).toBe(false);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    const results = side[1]!.context.messages.slice(side[0]!.context.messages.length).filter((m) => m.role === "toolResult") as Extract<Message, { role: "toolResult" }>[];
    expect(results.map((r) => [r.toolName, r.isError])).toEqual([["ls", false], ["write", true], ["bash", true]]);
    expect(JSON.stringify(results[0]!.content)).toContain("notes.txt");

    // The main agent's next turn.
    reply = () => fauxAssistantMessage(fauxText("ok"));
    await session.prompt("carry on");
    const next = calls.at(-1)!;
    const first = side[0]!;

    // Same transcript up to the new user message: system message (prompt and tools), the main turn, the context rewrite.
    const shared = next.context.messages.length - 1;
    expect(first.context.messages).toHaveLength(shared + 1);
    expect(first.context.messages.slice(0, shared)).toEqual(next.context.messages.slice(0, shared));
    expect(getInitialSystemMessage(first.context.messages)).toEqual(getInitialSystemMessage(next.context.messages));
    expect(getCurrentTools(first.context.messages).map((t) => t.name)).toEqual(getCurrentTools(next.context.messages).map((t) => t.name));
    expect(lastUserText(first)).toMatch(/^\[\/btw side chat\][\s\S]*sees? the main conversation[\s\S]*which deploy target\?$/);
    expect(JSON.stringify(first.context.messages)).toContain("look at notes.txt [ctx]");

    // As the provider payload Codex builds (Responses `input`), and with the same cache key and effort.
    const model = session.model!;
    const input = (c: Call) => convertResponsesMessages(model, c.context, new Set([model.provider]), { includeSystemPrompt: true });
    expect(input(first).slice(0, input(next).length - 1)).toEqual(input(next).slice(0, -1));
    expect(first.options?.sessionId).toBe(next.options?.sessionId);
    expect(first.options?.sessionId).toBe(session.sessionManager.getSessionId());
    expect(first.options?.reasoning).toBe(next.options?.reasoning);

    // A follow-up in the side chat extends the side chat's own request, so its cache holds too.
    reply = () => fauxAssistantMessage(fauxText("yes"));
    await handle.ask(ctx, "sure?");
    const follow = calls.at(-1)!;
    expect(follow.context.messages.slice(0, side[1]!.context.messages.length + 1)).toEqual([...side[1]!.context.messages, expect.objectContaining({ role: "assistant" })]);
    expect(lastUserText(follow)).toBe("sure?");

    // Nothing from the side chat reached the main conversation; it is saved as custom entries.
    expect(JSON.stringify(next.context.messages)).not.toContain("which deploy target");
    expect(JSON.stringify(session.messages)).not.toMatch(/which deploy target|btw side chat/);
    const saved = session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === BTW_ENTRY);
    expect(saved.map((e) => (e as { data: { question: string; answer: string } }).data)).toMatchObject([
      { question: "which deploy target?", answer: "staging-eu" },
      { question: "sure?", answer: "yes" },
    ]);
  });
});

describe("the main conversation mid-step", async () => {
  const { withoutOpenToolCalls } = await import("../../src/btw/side-chat.js");
  const user = { role: "user", content: "go", timestamp: 1 };
  const call = (...ids: string[]) => ({ role: "assistant", content: ids.map((id) => ({ type: "toolCall", id, name: "bash", arguments: {} })), timestamp: 2 });
  const result = (id: string) => ({ role: "toolResult", toolCallId: id, toolName: "bash", content: [], isError: false, timestamp: 3 });
  it("leaves out a step whose tool calls haven't all returned, and keeps a finished one", () => {
    const open = [user, call("a", "b"), result("a")] as never[];
    expect(withoutOpenToolCalls(open)).toEqual([user]);
    const done = [user, call("a", "b"), result("a"), result("b")] as never[];
    expect(withoutOpenToolCalls(done)).toEqual(done);
  });
});
