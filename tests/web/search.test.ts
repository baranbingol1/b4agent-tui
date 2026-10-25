import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { DEFAULT_ROLES } from "../../src/config.js";
import { accountId, buildSearchBody, CODEX_RESPONSES_URL, extractSearch, OPENAI_RESPONSES_URL, parseResponses, pickSearchTarget, webSearch } from "../../src/web/search.js";
import { stripUtm } from "../../src/extension/web.js";

const m = (provider: string, id: string, extra: Partial<Model<Api>> = {}) =>
  ({
    provider, id, name: id, input: ["text"],
    api: provider === "openai-codex" ? "openai-codex-responses" : provider === "openai" ? "openai-responses" : "anthropic-messages",
    baseUrl: provider === "openai-codex" ? "https://chatgpt.com/backend-api" : provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com",
    ...extra,
  }) as Model<Api>;

const registry = (models: Model<Api>[], authed = (_: Model<Api>) => true) => ({ getAll: () => models, hasConfiguredAuth: authed });

// A JWT whose payload carries the ChatGPT account id, like the Codex OAuth token.
const jwt = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-123" } })).toString("base64url")}.y`;

describe("pickSearchTarget", () => {
  it("uses the smol role on the Codex login", () => {
    const t = pickSearchTarget(registry([m("openai-codex", "gpt-6.1-sol"), m("openai-codex", "gpt-6-luna")]), DEFAULT_ROLES);
    expect(t).toMatchObject({ endpoint: "codex", url: CODEX_RESPONSES_URL, model: { id: "gpt-6-luna" } });
  });
  it("falls back to Sign in with ChatGPT (openai) and its cheapest model", () => {
    const t = pickSearchTarget(registry([m("openai", "gpt-6.1-sol"), m("openai", "gpt-6-luna"), m("openai", "gpt-6-pro")]), DEFAULT_ROLES);
    expect(t).toMatchObject({ endpoint: "openai", url: OPENAI_RESPONSES_URL, model: { id: "gpt-6-luna" } });
  });
  it("skips a smol role on another vendor and providers without a login", () => {
    const models = [m("anthropic", "claude-x"), m("openai-codex", "gpt-6-luna"), m("openai", "gpt-6-sol")];
    const t = pickSearchTarget(registry(models, (x) => x.provider !== "openai-codex"), { ...DEFAULT_ROLES, smol: ["anthropic/claude-x"] });
    expect(t).toMatchObject({ endpoint: "openai", model: { id: "gpt-6-sol" } });
  });
  it("refuses a model moved to a gateway, and returns nothing without an OpenAI login", () => {
    expect(pickSearchTarget(registry([m("openai", "gpt-6-luna", { baseUrl: "https://gateway.example/v1" })]), DEFAULT_ROLES)).toBeUndefined();
    expect(pickSearchTarget(registry([m("anthropic", "claude-x")]), DEFAULT_ROLES)).toBeUndefined();
  });
});

describe("request", () => {
  const sse = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "web_search_call", action: { query: "q" } } })}\n\ndata: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hi", annotations: [] }] } })}\n\n`;
  const capture = () => {
    const calls: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(sse);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetch };
  };

  it("sends the Codex shape: backend-api URL, account id, originator", async () => {
    const { calls, fetch } = capture();
    const target = { model: m("openai-codex", "gpt-6-luna"), endpoint: "codex" as const, url: CODEX_RESPONSES_URL };
    await webSearch(target, { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: jwt }) }, "q", { fetch, allowedDomains: ["https://Docs.Python.org/3/"] });
    expect(calls[0]!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(calls[0]!.headers).toMatchObject({ Authorization: `Bearer ${jwt}`, "chatgpt-account-id": "acct-123", originator: "pi", "OpenAI-Beta": "responses=experimental" });
    expect(calls[0]!.body).toMatchObject({ model: "gpt-6-luna", store: false, stream: true, tool_choice: "required", tools: [{ type: "web_search", filters: { allowed_domains: ["docs.python.org"] } }], include: ["web_search_call.action.sources"] });
  });

  it("sends the openai shape without Codex headers", async () => {
    const { calls, fetch } = capture();
    const target = { model: m("openai", "gpt-6-luna"), endpoint: "openai" as const, url: OPENAI_RESPONSES_URL };
    await webSearch(target, { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "tok", headers: { "x-extra": "1" } }) }, "q", { fetch });
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/responses");
    expect(calls[0]!.headers["chatgpt-account-id"]).toBeUndefined();
    expect(calls[0]!.headers).toMatchObject({ Authorization: "Bearer tok", "x-extra": "1" });
  });

  it("redacts the token from errors and rejects answers without a search", async () => {
    const target = { model: m("openai", "gpt-6-luna"), endpoint: "openai" as const, url: OPENAI_RESPONSES_URL };
    const auth = { getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "secret-token-value" }) };
    const bad = (async () => new Response("bad token secret-token-value", { status: 401 })) as unknown as typeof fetch;
    await expect(webSearch(target, auth, "q", { fetch: bad })).rejects.toThrow(/HTTP 401: bad token \[token\]$/);
    const noSearch = (async () => new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ text: "from memory" }] } })}\n`)) as unknown as typeof fetch;
    await expect(webSearch(target, auth, "q", { fetch: noSearch })).rejects.toThrow(/without running a web search/);
  });

  it("puts today's date in the instructions", () => {
    expect(String(buildSearchBody("m", "q", { now: new Date("2026-10-21T10:00:00Z") }).instructions)).toContain("Today is 2026-10-21.");
  });
});

describe("parsing", () => {
  it("reads citations, consulted sources and queries", () => {
    const out = extractSearch([
      { type: "web_search_call", action: { query: "a", sources: [{ url: "https://x.example/1", title: "X" }, { url: "https://cited.example/?utm_source=openai" }] } },
      { type: "message", content: [{ type: "output_text", text: "Answer.", annotations: [{ type: "url_citation", url: "https://cited.example/?utm_source=openai", title: "Cited" }] }] },
    ]);
    expect(out).toEqual({ answer: "Answer.", citations: [{ url: "https://cited.example/", title: "Cited" }], consulted: [{ url: "https://x.example/1", title: "X" }], queries: ["a"] });
  });
  it("surfaces stream errors", () => {
    expect(() => parseResponses(`data: ${JSON.stringify({ type: "error", error: { code: "rate_limit", message: "slow" } })}\n`)).toThrow(/rate_limit.*slow/);
    expect(() => parseResponses(`data: ${JSON.stringify({ type: "response.failed", response: { error: { message: "nope" } } })}\n`)).toThrow(/nope/);
  });
  it("prefers the completed response's output", () => {
    const items = parseResponses(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "a" } })}\ndata: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "b" }] } })}\n`);
    expect(items).toEqual([{ type: "b" }]);
  });
  it("reads the account id from the token", () => {
    expect(accountId(jwt)).toBe("acct-123");
    expect(accountId("not-a-jwt")).toBeUndefined();
  });
  it("strips OpenAI's utm tag from answer links", () => {
    expect(stripUtm("[a](https://a.com/x?utm_source=openai) [b](https://b.com/?q=1&utm_source=openai) [c](https://c.com/?utm_source=openai&q=2)")).toBe("[a](https://a.com/x) [b](https://b.com/?q=1) [c](https://c.com/?q=2)");
  });
});
