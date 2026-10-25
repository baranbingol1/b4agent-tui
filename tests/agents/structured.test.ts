import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type AgentSession, type ExtensionFactory, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * Structured output and agent_create through a real Pi session: the main
 * session runs b4agent's agents extension, children are real in-process
 * sessions, and a faux provider plays every model from a script keyed by the
 * last user (or delivered) message.
 */
type Call = { tool: string; args: JsonObject };
const requests: TranscriptContext[] = [];
const script: Record<string, Call[][]> = {};
const choices: (string | undefined)[] = [];
const inputs: (string | undefined)[] = [];
const titles: string[] = [];
let dir: string;
let home: string;
let session: AgentSession;
const saved: Record<string, string | undefined> = {};

const textOf = (m: TranscriptContext["messages"][number] | undefined) =>
  !m || !("content" in m) ? "" : typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
const lastUser = (c: TranscriptContext) => textOf(c.messages.findLast((m) => m.role === "user"));
/** Tool results the model saw in the request that answered `prompt`. */
const resultsFor = (prompt: string): { tool: string; error?: boolean; text: string }[] =>
  requests.flatMap((c) => (lastUser(c) === prompt || lastUser(c).endsWith(`\n${prompt}`) ? c.messages.slice(c.messages.findLastIndex((m) => m.role === "user")).filter((m) => m.role === "toolResult").map((m) => ({ tool: (m as { toolName: string }).toolName, error: (m as { isError?: boolean }).isError, text: textOf(m) })) : []));
/** The agents prompt section as each request saw it: the first system message has every section, later ones patch by name. */
const agentsSections = (c: TranscriptContext) => c.messages.filter((m) => m.role === "system" && (m as { sections?: Record<string, unknown> }).sections?.agents !== undefined).map((m) => String((m as { sections: Record<string, unknown> }).sections.agents));

const TYPE = `---
name: counter
description: "Counts things and returns the count."
model: "@smol"
output:
  type: object
  required: [n]
  properties:
    n: { type: integer, minimum: 0 }
  additionalProperties: false
---

You count things.
`;

function respond(c: TranscriptContext) {
  requests.push(c);
  const key = lastUser(c).trim();
  const entry = script[key] ?? Object.entries(script).find(([k]) => key.endsWith(`\n${k}`))?.[1] ?? [];
  const at = c.messages.findLastIndex((m) => m.role === "user");
  const done = c.messages.slice(at + 1).filter((m) => m.role === "assistant").length;
  if (done < entry.length) return fauxAssistantMessage(entry[done]!.map((x) => fauxToolCall(x.tool, x.args)), { stopReason: "toolUse" });
  return fauxAssistantMessage(fauxText(`done: ${key.slice(0, 40)}`));
}

async function prompt(text: string) {
  await session.prompt(text);
  await session.agent.waitForIdle?.();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "b4-structured-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  for (const k of ["B4AGENT_HOME", "PI_CODING_AGENT_DIR"]) saved[k] = process.env[k];
  process.env.B4AGENT_HOME = home;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  const agents = (await import("../../src/extension/agents.js")).default;
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  faux.setResponses(Array.from({ length: 200 }, () => respond));
  const maker = ({ child }: { child?: never }): ExtensionFactory => (pi) => {
    pi.registerProvider(faux.provider);
    agents(pi, { ...(child ? { child } : {}), makeExtension: maker as never });
  };
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory(),
    noPromptTemplates: true,
    noThemes: true,
    noSkills: true,
    extensionFactories: [{ name: "b4agent", factory: maker({}) }],
  });
  await loader.reload();
  ({ session } = await createAgentSession({
    cwd: dir,
    agentDir: join(dir, "agent"),
    model: faux.getModel(),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(dir),
    settingsManager: SettingsManager.inMemory(),
  }));
  const ui = new Proxy(
    {
      select: async (title: string) => (titles.push(title), choices.shift()),
      input: async () => inputs.shift(),
      editor: async () => undefined,
      confirm: async () => false,
    } as Record<string, unknown>,
    { get: (t, k) => (k in t ? t[k as string] : () => undefined) },
  );
  await session.bindExtensions({ uiContext: ui as never, mode: "print", onError: (e) => { throw new Error(String(e.error)); } });
}, 30_000);

afterAll(async () => {
  session?.dispose?.();
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  rmSync(dir, { recursive: true, force: true });
});

describe("agent_create", () => {
  it("rejected: nothing is written and the agent gets the user's reason", async () => {
    script["make a bad type"] = [[{ tool: "agent_create", args: { name: "counter", scope: "global", content: TYPE } }]];
    choices.push("Reject and say why");
    inputs.push("too broad");
    await prompt("make a bad type");
    expect(titles.at(-1)).toContain('Create subagent type "counter"?');
    // The dialog shows the file itself.
    expect(titles.at(-1)).toContain("additionalProperties: false");
    const [r] = resultsFor("make a bad type");
    expect(r?.text).toContain("rejected");
    expect(r?.text).toContain("They said: too broad");
    expect(existsSync(join(home, "agents", "counter.md"))).toBe(false);
  });

  it("approved: the type is usable in the same run and enters the agents section once", async () => {
    const before = requests.length;
    script["make the type"] = [
      [{ tool: "agent_create", args: { name: "counter", scope: "global", content: TYPE } }],
      [{ tool: "agent", args: { type: "counter", prompt: "count the files", background: false } }],
    ];
    // The child: a wrong submit first, then a valid one.
    script["count the files"] = [[{ tool: "submit", args: { result: "first try", data: { n: "three" } } }], [{ tool: "submit", args: { result: "three files", data: { n: 3 } } }]];
    choices.push("Create");
    await prompt("make the type");
    expect(existsSync(join(home, "agents", "counter.md"))).toBe(true);
    const results = resultsFor("make the type");
    expect(results.find((r) => r.tool === "agent_create")?.text).toContain('It is available now: start it with agent { type: "counter" }');
    // Schema reject, then accept: the child saw the validation error and the parent got the data as JSON.
    const child = resultsFor("count the files").filter((r) => r.tool === "submit");
    expect(child[0]).toMatchObject({ error: true });
    expect(child[0]!.text).toContain("/n: must be integer");
    const agent = results.find((r) => r.tool === "agent")!.text;
    expect(agent).toContain("three files");
    expect(agent).toContain('"n": 3');
    expect(agent).not.toContain("first try");

    // Earlier requests didn't list the type; the next run's request does, and a run after that adds no new patch.
    expect(requests.slice(0, before).flatMap(agentsSections).some((s) => s.includes("- counter"))).toBe(false);
    await prompt("hello");
    const hello = requests.findLast((c) => lastUser(c) === "hello")!;
    const sections = agentsSections(hello);
    expect(sections.at(-1)).toContain("- counter (structured output): Counts things");
    await prompt("hello again");
    const again = requests.findLast((c) => lastUser(c) === "hello again")!;
    expect(agentsSections(again)).toHaveLength(sections.length);
  });
});

describe("structured output", () => {
  it("the call's schema replaces the type's", async () => {
    script["use my schema"] = [[{ tool: "agent", args: { type: "counter", prompt: "name a color", background: false, schema: { type: "object", required: ["color"], properties: { color: { type: "string" } } } } }]];
    script["name a color"] = [[{ tool: "submit", args: { result: "picked", data: { color: "teal" } } }]];
    await prompt("use my schema");
    const agent = resultsFor("use my schema").find((r) => r.tool === "agent")!.text;
    expect(agent).toContain('"color": "teal"');
    // The child's system prompt carried the call's schema, not the type's.
    const childReq = requests.find((c) => lastUser(c).endsWith("name a color"))!;
    expect(JSON.stringify(childReq.messages[0])).toContain('\\"color\\"');
    expect(JSON.stringify(childReq.messages[0])).not.toContain("minimum");
  });

  it("a child that never submits is reminded 3 times, then its last message is returned", async () => {
    script["lazy count"] = [[{ tool: "agent", args: { type: "counter", prompt: "count lazily", background: false } }]];
    await prompt("lazy count");
    const childReqs = requests.filter((c) => {
      const brief = textOf(c.messages.find((m) => m.role === "user"));
      return brief.endsWith("count lazily");
    });
    const reminders = childReqs.map(lastUser).filter((t) => t.startsWith("[submit reminder"));
    expect(reminders).toEqual([expect.stringContaining("1/3"), expect.stringContaining("2/3"), expect.stringContaining("3/3")]);
    expect(reminders[2]).toContain("last reminder");
    // The brief plus three reminders: four requests, no fifth.
    expect(childReqs).toHaveLength(4);
    const agent = resultsFor("lazy count").find((r) => r.tool === "agent")!.text;
    expect(agent).toContain("returned no data for the output schema after 3 reminders");
  });

  it("a child that submits right away gets no reminder", async () => {
    script["quick count"] = [[{ tool: "agent", args: { type: "counter", prompt: "count quickly", background: false } }]];
    script["count quickly"] = [[{ tool: "submit", args: { result: "zero", data: '{"n": 0}' } }]];
    await prompt("quick count");
    expect(requests.some((c) => lastUser(c).startsWith("[submit reminder") && textOf(c.messages.find((m) => m.role === "user")).endsWith("count quickly"))).toBe(false);
    // A JSON string for an object is accepted parsed.
    expect(resultsFor("quick count").find((r) => r.tool === "agent")!.text).toContain('"n": 0');
  });
});
