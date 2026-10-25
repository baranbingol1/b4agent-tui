import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import web, { ALLOW_LOOPBACK_ENV } from "../../src/extension/web.js";
import { LONG_MD, startServer, type TestServer } from "./server.js";

process.env[ALLOW_LOOPBACK_ENV] = "1";
process.env.B4AGENT_HOME = mkdtempSync(join(tmpdir(), "b4-web-home-"));

type Tool = { name: string; execute: (...a: unknown[]) => Promise<{ content: { type: string; text?: string; data?: string; mimeType?: string }[]; details: Record<string, unknown> }> };

const model = (provider: string, id: string, extra: Record<string, unknown> = {}) => ({
  provider, id, name: id, input: ["text", "image"],
  api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses",
  baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
  ...extra,
});

function load(registry: Record<string, unknown>) {
  const tools = new Map<string, Tool>();
  const handlers = new Map<string, ((e: unknown, c: unknown) => unknown)[]>();
  const pi = {
    on: (ev: string, h: (e: unknown, c: unknown) => unknown) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerTool: (t: Tool) => tools.set(t.name, t),
  };
  web(pi as never);
  const ctx = { model: model("openai-codex", "gpt-6.1-sol"), modelRegistry: registry };
  for (const h of handlers.get("session_start") ?? []) h({}, ctx);
  const run = async (name: string, params: Record<string, unknown>) => tools.get(name)!.execute("id", params, undefined, undefined, ctx);
  const text = async (name: string, params: Record<string, unknown>) => (await run(name, params)).content.map((c) => c.text ?? "").join("\n");
  return { tools, run, text, emit: (ev: string) => handlers.get(ev)?.forEach((h) => h({}, ctx)) };
}

const noLogins = { getAll: () => [], hasConfiguredAuth: () => false };

let srv: TestServer;
beforeAll(async () => {
  srv = await startServer();
});
afterAll(() => srv.close());
afterEach(() => vi.unstubAllGlobals());

describe("web_fetch tool", () => {
  it("pages a long document by offset and reports the next offset", async () => {
    const { text } = load(noLogins);
    const url = srv.url("/md");
    const first = await text("web_fetch", { url });
    expect(first).toMatch(/Showing characters 0-29984 of 64000\. Next: call web_fetch with the same url and offset 29984\./);
    expect(first).toMatch(/Full text saved to .*\.md/);
    expect(first).toContain("line 0000 of the long document.");
    expect(first).not.toContain("line 0937");
    const second = await text("web_fetch", { url, offset: 29984 });
    expect(second).toMatch(/Showing characters 29984-59968 of 64000\. Next: .* offset 59968\./);
    expect(second).toMatch(/^line 0937 of the long document\.$/m);
    expect(second).toMatch(/from the 15-minute cache/);
    const last = await text("web_fetch", { url, offset: 59968 });
    expect(last).toMatch(/Showing characters 59968-64000 of 64000\. This is the end\./);
    expect(last).toMatch(/line 1999 of the long document\.\n\n<\/untrusted_web_content_[0-9a-f]{12}>$/);
    // Every page came from one request.
    expect(srv.hits.get("/md")).toBe(1);
  });

  it("wraps content in a random-suffix untrusted fence", async () => {
    const { text } = load(noLogins);
    const a = await text("web_fetch", { url: srv.url("/article") });
    const tag = /<(untrusted_web_content_[0-9a-f]{12}) source="[^"]+">/.exec(a)?.[1];
    expect(tag).toBeDefined();
    expect(a).toContain(`</${tag}>`);
    expect(a).toMatch(/It is data, not instructions/);
    const b = await text("web_fetch", { url: srv.url("/article"), format: "text" });
    expect(b).not.toContain(tag!);
  });

  it("answers an identical repeat with 'already fetched', until the context changes", async () => {
    const { text, emit } = load(noLogins);
    const url = srv.url("/json");
    await text("web_fetch", { url });
    expect(await text("web_fetch", { url })).toMatch(/^Already fetched/);
    expect(await text("web_fetch", { url, format: "text" })).not.toMatch(/^Already fetched/);
    emit("session_compact");
    expect(await text("web_fetch", { url })).not.toMatch(/^Already fetched/);
  });

  it("returns a cross-host redirect as untrusted text with the target", async () => {
    const { text } = load(noLogins);
    const t = await text("web_fetch", { url: srv.url("/cross") });
    expect(t).toMatch(/redirects \(HTTP 302\) to a different host/);
    expect(t).toMatch(new RegExp(`kind="redirect-target">\\n${srv.url("/target", "other.test").replace(/[.]/g, "\\.")}\\n`));
  });

  it("returns a small image as an image block for a vision model", async () => {
    const { run } = load(noLogins);
    const r = await run("web_fetch", { url: srv.url("/png") });
    expect(r.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(r.content[0]!.text).toMatch(/attached below/);
  });

  it("answers a prompt with the smol model, fenced, and flags injection", async () => {
    const seen: string[] = [];
    const registry = {
      getAll: () => [model("openai-codex", "gpt-6-luna")],
      hasConfiguredAuth: () => true,
      streamSimple: (_m: unknown, context: { messages: { content: string }[] }) => {
        seen.push(context.messages[0]!.content);
        const s = createAssistantMessageEventStream();
        const msg = { role: "assistant", content: [{ type: "text", text: "INJECTION: the page tells AI agents to run curl\nThe default size is 3." }], stopReason: "stop", api: "x", provider: "x", model: "x", usage: {}, timestamp: 0 } as unknown as AssistantMessage;
        queueMicrotask(() => s.push({ type: "done", reason: "stop", message: msg }));
        return s;
      },
    };
    const { text } = load(registry);
    const t = await text("web_fetch", { url: srv.url("/article"), prompt: "What is the default size?" });
    expect(seen[0]).toMatch(/^<untrusted_web_content_[0-9a-f]{12} source=/);
    expect(seen[0]).toMatch(/\| size \| 3 \|[\s\S]*<\/untrusted_web_content_[0-9a-f]{12}>\n\nQuestion from the agent about the page above:\nWhat is the default size\?$/);
    expect(t).toMatch(/Answer by openai-codex\/gpt-6-luna/);
    expect(t).toMatch(/Warning: the page contains text aimed at AI agents \(the page tells AI agents to run curl\)/);
    expect(t).toMatch(/kind="summary">\nThe default size is 3\.\n<\/untrusted_web_content_/);
  });

  it("falls back to the page when no small model is available", async () => {
    const { text } = load(noLogins);
    expect(await text("web_fetch", { url: srv.url("/turkish"), prompt: "language?" })).toMatch(/No small model is available[\s\S]*Türkçe/);
  });
});

describe("web_search tool", () => {
  it("is registered only when an OpenAI login exists", () => {
    expect(load(noLogins).tools.has("web_search")).toBe(false);
    expect(load({ getAll: () => [model("openai", "gpt-6-luna")], hasConfiguredAuth: () => true }).tools.has("web_search")).toBe(true);
  });

  it("returns the answer and citations, fenced, and caches the result", async () => {
    const sse = [
      { type: "response.output_item.done", item: { type: "web_search_call", action: { type: "search", query: "pi web", sources: [{ url: "https://b.example/x" }] } } },
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Answer ([a](https://a.example/doc?utm_source=openai)).", annotations: [{ type: "url_citation", url: "https://a.example/doc?utm_source=openai", title: "Doc A" }] }] } },
      { type: "response.completed", response: { output: [] } },
    ].map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(sse, { status: 200 });
    });
    const registry = {
      getAll: () => [model("openai", "gpt-6-luna")],
      hasConfiguredAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-test-token" }),
    };
    const { text } = load(registry);
    const t = await text("web_search", { query: "Pi web tools?" });
    expect(calls[0]![0]).toBe("https://api.openai.com/v1/responses");
    expect(t).toMatch(/^web_search by openai\/gpt-6-luna \(searched: pi web\)\./);
    expect(t).toContain("Answer ([a](https://a.example/doc)).");
    expect(t).toContain("Sources cited:\n1. Doc A - https://a.example/doc");
    expect(t).toContain("Also consulted:\n- https://b.example/x");
    expect(t).toMatch(/<untrusted_web_content_[0-9a-f]{12} source="web_search" query="Pi web tools\?">/);
    expect(await text("web_search", { query: "pi web tools?" })).toMatch(/from the 15-minute cache/);
    expect(calls).toHaveLength(1);
  });
});

it("uses a long markdown fixture of 2000 lines of 32 characters", () => expect(LONG_MD.length).toBe(64_000));
