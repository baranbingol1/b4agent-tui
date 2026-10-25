import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { getCurrentTools, getInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import recap, { type RecapHandle } from "../../src/extension/recap.js";
import { RECAP_REQUEST, RECAP_SYSTEM } from "../../src/recap/generate.js";

/**
 * The main-model recap must send what the main agent's next request would
 * send, with the recap request appended, so the provider's prompt cache
 * covers everything but that request (the /btw mechanism). Once the cache is
 * cold it must take the small path: the recap role's model, excerpts only.
 */
type Call = { model: string; context: TranscriptContext; options: SimpleStreamOptions | undefined };
const calls: Call[] = [];
let reply: (c: Call) => ReturnType<typeof fauxAssistantMessage>;
let dir: string;
let session: AgentSession;
let handle: RecapHandle;
let ctx: ExtensionContext;
let clock = 1_000_000;
const savedHome = process.env.B4AGENT_HOME;

const lastUserText = (c: Call) => {
  const u = c.context.messages.findLast((m) => m.role === "user");
  return typeof u?.content === "string" ? u.content : (u?.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("");
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "b4-recap-"));
  // The recap role points at a second faux model, so the small path is visible.
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "home", "b4agent.json"), JSON.stringify({ models: { roles: { recap: "faux/small:low" } } }));
  process.env.B4AGENT_HOME = join(dir, "home");
  writeFileSync(join(dir, "notes.txt"), "TOOL-OUTPUT: the deploy target is staging-eu\n");
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m", reasoning: true }, { id: "small", reasoning: true }] });
  faux.setResponses(Array.from({ length: 50 }, () => (context: TranscriptContext, options: SimpleStreamOptions | undefined, _state: unknown, model: { id: string }) => {
    const c = { model: model.id, context, options };
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
          // Another extension rewriting context: the recap must see the rewritten transcript, as the provider does.
          pi.on("context", (e) => ({
            messages: e.messages.map((m) => (m.role === "user" && Array.isArray(m.content) ? { ...m, content: m.content.map((b) => (b.type === "text" ? { ...b, text: b.text + " [ctx]" } : b)) } : m)),
          }));
          pi.on("agent_end", (_e, c) => void (ctx = c));
          handle = recap(pi, { now: () => clock });
        },
      },
    ],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    model: faux.getModel("m"),
    thinkingLevel: "high",
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  }));
  await session.bindExtensions({ mode: "print", onError: (e) => { throw new Error(String(e.error)); } });
});

afterAll(() => {
  session?.dispose?.();
  if (savedHome === undefined) delete process.env.B4AGENT_HOME;
  else process.env.B4AGENT_HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

describe("recap requests", () => {
  it("on a warm cache, sends the main agent's next request with the recap request appended", async () => {
    // Three main turns, the first with a tool call.
    reply = (c) => (c.context.messages.at(-1)?.role === "toolResult" ? fauxAssistantMessage(fauxText("read it")) : fauxAssistantMessage([fauxToolCall("read", { path: "notes.txt" })], { stopReason: "toolUse" }));
    await session.prompt("look at notes.txt");
    reply = () => fauxAssistantMessage(fauxText("done"));
    await session.prompt("now summarise the plan");
    await session.prompt("ok, ship it tomorrow");
    const mainCalls = calls.length;

    // Two minutes later (a warm 5-minute cache): the main model, with the main prefix.
    clock += 120_000;
    reply = () => fauxAssistantMessage(fauxText("Reading notes.txt to find the deploy target: staging-eu; shipping is planned.\nNext: ship it tomorrow"));
    const r = await handle.generate(ctx);
    expect(r).toMatchObject({ route: "main", model: "faux/m", text: "Reading notes.txt to find the deploy target: staging-eu; shipping is planned.", next: "ship it tomorrow" });
    expect(calls).toHaveLength(mainCalls + 1);
    const side = calls.at(-1)!;
    expect(side.model).toBe("m");
    // The faux provider simulates a prefix cache per session id: almost all input is a cache hit.
    expect(r.usage!.cacheRead).toBeGreaterThan(5 * r.usage!.input);

    // The main agent's next turn.
    reply = () => fauxAssistantMessage(fauxText("ok"));
    await session.prompt("carry on");
    const next = calls.at(-1)!;
    const shared = next.context.messages.length - 1;
    expect(side.context.messages).toHaveLength(shared + 1);
    expect(side.context.messages.slice(0, shared)).toEqual(next.context.messages.slice(0, shared));
    expect(getInitialSystemMessage(side.context.messages)).toEqual(getInitialSystemMessage(next.context.messages));
    expect(getCurrentTools(side.context.messages).map((t) => t.name)).toEqual(getCurrentTools(next.context.messages).map((t) => t.name));
    expect(lastUserText(side)).toBe(RECAP_REQUEST);
    expect(JSON.stringify(side.context.messages)).toContain("look at notes.txt [ctx]");

    // As the Responses `input` Codex builds, with the same cache key and effort.
    const model = session.model!;
    const input = (c: Call) => convertResponsesMessages(model, c.context, new Set([model.provider]), { includeSystemPrompt: true });
    expect(input(side).slice(0, input(next).length - 1)).toEqual(input(next).slice(0, -1));
    expect(side.options?.sessionId).toBe(session.sessionManager.getSessionId());
    expect(side.options?.sessionId).toBe(next.options?.sessionId);
    expect(side.options?.reasoning).toBe(next.options?.reasoning);

    // The recap never reached the main conversation.
    expect(JSON.stringify(next.context.messages)).not.toMatch(/\[recap\]|deploy target: staging-eu; shipping/);
  });

  it("on a cold cache, takes the small path: the recap role's model and excerpts, no tool output", async () => {
    clock += 10 * 60_000;
    reply = () => fauxAssistantMessage(fauxText("Shipping the staging-eu deploy; the agent is carrying on."));
    const r = await handle.generate(ctx);
    expect(r).toMatchObject({ route: "small", model: "faux/small", text: "Shipping the staging-eu deploy; the agent is carrying on." });
    const c = calls.at(-1)!;
    expect(c.model).toBe("small");
    expect(c.options?.reasoning).toBe("low");
    expect(getInitialSystemMessage(c.context.messages)).toMatchObject({ content: RECAP_SYSTEM });
    expect(getCurrentTools(c.context.messages)).toHaveLength(0);
    const text = lastUserText(c);
    expect(text).toContain("<first_request>\nlook at notes.txt");
    expect(text).toContain("<last_user_message>\ncarry on");
    expect(text).toContain("<last_agent_reply>\nok");
    expect(text).not.toContain("TOOL-OUTPUT");
  });
});
