/**
 * web_search through the user's OpenAI login (plan section 8, "Web search
 * through the subscription"): a side request to the Responses API with the
 * hosted `{type: "web_search"}` tool, returning the answer and its citations.
 *
 * Request shapes follow pi-web-access 0.44.0 (`openai-search.ts`, MIT,
 * Copyright (c) 2025 Nico Bailon):
 * - `openai-codex` (the legacy ChatGPT OAuth token):
 *   `chatgpt.com/backend-api/codex/responses` with `chatgpt-account-id`
 *   (from the token's JWT claims), `originator` and `OpenAI-Beta` headers.
 * - `openai` (Sign in with ChatGPT, or an API key): `api.openai.com/v1/responses`.
 * Both stream (the Codex backend requires `stream: true` and `store: false`).
 *
 * The request goes straight to OpenAI rather than through Pi's provider:
 * Pi's Responses parser drops `web_search_call` items and `url_citation`
 * annotations, so the citations would be lost.
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModel } from "../config.js";
import { logSideUsage, type SideUsage } from "../usage-log.js";

export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const SEARCH_TIMEOUT_MS = 90_000;

export interface SearchModels {
  getAll(): Model<Api>[];
  hasConfiguredAuth(model: Model<Api>): boolean;
  getApiKeyAndHeaders(model: Model<Api>): Promise<{ ok: true; apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string } | { ok: false; error: string }>;
}

export interface SearchTarget {
  model: Model<Api>;
  endpoint: "codex" | "openai";
  url: string;
}

function officialEndpoint(model: Model<Api>, baseUrl = model.baseUrl): SearchTarget | undefined {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const path = u.pathname.replace(/\/+$/, "");
  if (u.protocol !== "https:") return undefined;
  if (model.provider === "openai-codex" && model.api === "openai-codex-responses" && u.hostname === "chatgpt.com" && path === "/backend-api") {
    return { model, endpoint: "codex", url: CODEX_RESPONSES_URL };
  }
  if (model.provider === "openai" && model.api === "openai-responses" && u.hostname === "api.openai.com" && path === "/v1") {
    return { model, endpoint: "openai", url: OPENAI_RESPONSES_URL };
  }
  return undefined;
}

/** Cheapest first: a `luna` model, then a bare `gpt-N(.M)`, then any other GPT; never `pro`/`ultra` tiers (pi-web-access's order). */
function pickCheap(models: Model<Api>[]): Model<Api> | undefined {
  const ok = models
    .filter((m) => /^gpt-\d/.test(m.id) && !m.id.split("-").some((s) => s === "pro" || s === "ultra"))
    .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
  return ok.find((m) => m.id.includes("luna")) ?? ok.find((m) => /^gpt-\d+(\.\d+)?$/.test(m.id)) ?? ok[0];
}

/**
 * The model and endpoint for searches: the configured `smol` role when it is
 * on an OpenAI login, otherwise the cheapest GPT model on `openai-codex`,
 * then `openai`. Undefined when neither login exists.
 */
export function pickSearchTarget(models: Pick<SearchModels, "getAll" | "hasConfiguredAuth">, roles: Record<string, string[]>): SearchTarget | undefined {
  const smol = resolveModel("@smol", roles, models);
  const viaSmol = smol && officialEndpoint(smol.model);
  if (viaSmol) return viaSmol;
  const all = models.getAll();
  for (const provider of ["openai-codex", "openai"]) {
    const m = pickCheap(all.filter((x) => x.provider === provider && models.hasConfiguredAuth(x) && officialEndpoint(x)));
    if (m) return officialEndpoint(m);
  }
  return undefined;
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function accountId(token: string): string | undefined {
  const auth = jwtClaims(token)?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const id = auth?.chatgpt_account_id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

export interface Citation {
  url: string;
  title: string;
}

export interface SearchResult {
  answer: string;
  /** Sources the answer cites (url_citation annotations), in order. */
  citations: Citation[];
  /** Other sources the search looked at. */
  consulted: Citation[];
  queries: string[];
  model: string;
}

export interface SearchOptions {
  allowedDomains?: string[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: Date;
}

export function buildSearchBody(model: string, query: string, opts: { allowedDomains?: string[]; now?: Date } = {}): Record<string, unknown> {
  const today = (opts.now ?? new Date()).toISOString().slice(0, 10);
  const domains = (opts.allowedDomains ?? []).map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean).slice(0, 100);
  const tool: Record<string, unknown> = { type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) };
  return {
    model,
    instructions: [
      `Search the web and answer from the results only. Today is ${today}.`,
      "Be concise and factual. Give exact names, versions, commands and API signatures as the sources state them, and cite the source for each claim.",
      "Say so when sources disagree, look outdated, or don't answer the question.",
    ].join(" "),
    input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
    tools: [tool],
    tool_choice: "required",
    include: ["web_search_call.action.sources"],
    reasoning: { effort: "low" },
    store: false,
    stream: true,
  };
}

const cleanUrl = (raw: string) => {
  try {
    const u = new URL(raw);
    if (u.searchParams.get("utm_source") === "openai") u.searchParams.delete("utm_source");
    return u.href;
  } catch {
    return raw;
  }
};

type Item = Record<string, unknown>;

/** Token usage from a Responses reply's completed event, in Pi's usage shape (cost unknown). */
export function responsesUsage(body: string): SideUsage | undefined {
  let u: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } | undefined;
  const t = body.trim();
  if (t.startsWith("{")) {
    try {
      u = (JSON.parse(t) as { usage?: typeof u }).usage;
    } catch {
      return undefined;
    }
  } else {
    for (const line of body.split("\n")) {
      if (!line.startsWith("data:") || !line.includes("usage")) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as { response?: { usage?: typeof u } };
        if (ev.response?.usage) u = ev.response.usage;
      } catch {
        // not a JSON event
      }
    }
  }
  if (!u) return undefined;
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  return { input: (u.input_tokens ?? 0) - cached, output: u.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 };
}

/** Output items of a streamed or plain Responses reply. Throws on a stream error event. */
export function parseResponses(body: string): Item[] {
  const t = body.trim();
  if (t.startsWith("{")) {
    const j = JSON.parse(t) as { output?: Item[]; error?: { message?: string } };
    if (j.error?.message) throw new Error(j.error.message);
    return j.output ?? [];
  }
  const items: Item[] = [];
  let completed: Item[] | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let ev: Item;
    try {
      ev = JSON.parse(data) as Item;
    } catch {
      continue;
    }
    const type = ev.type;
    if (type === "error") {
      const err = ev.error as { message?: string; code?: string } | undefined;
      throw new Error(`OpenAI stream error${err?.code ? ` (${err.code})` : ""}: ${err?.message ?? (ev.message as string | undefined) ?? "unknown"}`);
    }
    if (type === "response.failed") {
      const err = (ev.response as { error?: { message?: string } } | undefined)?.error;
      throw new Error(`OpenAI response failed: ${err?.message ?? "no error message"}`);
    }
    if (type === "response.output_item.done" && ev.item) items.push(ev.item as Item);
    if ((type === "response.completed" || type === "response.done" || type === "response.incomplete") && ev.response) {
      const out = (ev.response as { output?: Item[] }).output;
      if (out?.length) completed = out;
    }
  }
  return completed ?? items;
}

export function extractSearch(output: Item[]): Omit<SearchResult, "model"> {
  const answer: string[] = [];
  const citations: Citation[] = [];
  const consulted: Citation[] = [];
  const queries: string[] = [];
  const seen = new Set<string>();
  const add = (list: Citation[], url: unknown, title: unknown) => {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) return;
    const u = cleanUrl(url);
    if (seen.has(u)) return;
    seen.add(u);
    list.push({ url: u, title: typeof title === "string" && title.trim() ? title.trim() : u });
  };
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content as Item[]) {
      if (typeof part.text === "string" && part.text.trim()) answer.push(part.text);
      for (const a of (Array.isArray(part.annotations) ? part.annotations : []) as Item[]) {
        if (a.type === "url_citation") add(citations, a.url, a.title);
      }
    }
  }
  for (const item of output) {
    if (item.type !== "web_search_call") continue;
    const action = item.action as { query?: unknown; queries?: unknown; sources?: Item[] } | undefined;
    if (typeof action?.query === "string") queries.push(action.query);
    if (Array.isArray(action?.queries)) for (const q of action.queries) if (typeof q === "string") queries.push(q);
    for (const s of action?.sources ?? []) add(consulted, s.url, s.title);
  }
  return { answer: answer.join("\n").trim(), citations, consulted, queries: [...new Set(queries)] };
}

export async function webSearch(target: SearchTarget, models: Pick<SearchModels, "getApiKeyAndHeaders">, query: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const auth = await models.getApiKeyAndHeaders(target.model);
  if (!auth.ok) throw new Error(`No usable ${target.model.provider} login: ${auth.error}`);
  if (!auth.apiKey) throw new Error(`The ${target.model.provider} login has no access token.`);
  // A login that moved the model to another base URL (a gateway) must not send its credential to OpenAI.
  if (auth.baseUrl && !officialEndpoint(target.model, auth.baseUrl)) throw new Error(`The ${target.model.provider} login points at ${auth.baseUrl}, not OpenAI; web_search only uses the official endpoints.`);
  const token = auth.apiKey;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(auth.headers ?? {})) if (v !== null) headers[k] = v;
  Object.assign(headers, {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
  });
  if (target.endpoint === "codex") {
    const id = accountId(token);
    if (!id) throw new Error("The openai-codex token has no ChatGPT account id; log in again with /login.");
    headers["chatgpt-account-id"] = id;
    headers.originator = "pi";
  }
  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const body = buildSearchBody(target.model.id, query, { ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}), ...(opts.now ? { now: opts.now } : {}) });
  const redactToken = (s: string) => s.split(token).join("[token]");
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(target.url, { method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error" });
  } catch (e) {
    if (timeout.aborted && !opts.signal?.aborted) throw new Error(`web_search timed out after ${SEARCH_TIMEOUT_MS / 1000} s`);
    throw new Error(redactToken((e as Error).message));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI returned HTTP ${res.status}: ${redactToken(text).slice(0, 400)}`);
  const output = parseResponses(text);
  logSideUsage("web-search", `${target.model.provider}/${target.model.id}`, responsesUsage(text));
  const result = extractSearch(output);
  if (!output.some((i) => i.type === "web_search_call")) throw new Error("OpenAI answered without running a web search.");
  if (!result.answer && !result.citations.length && !result.consulted.length) throw new Error("The web search returned no answer and no sources.");
  return { ...result, model: `${target.model.provider}/${target.model.id}` };
}
