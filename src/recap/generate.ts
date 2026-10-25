import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, UserMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { ask, textOf } from "../btw/side-chat.js";
import type { SavedRecap } from "./trigger.js";

/**
 * Writing the recap (plan section 3). Preferred: a side turn on the main
 * model that sends the main agent's next request with the recap request
 * appended (the /btw mechanism in `src/btw/side-chat.ts`), so it is mostly
 * cache reads and sees the whole conversation. Fallback, when the provider
 * shows no cache or the cache has gone cold: the `recap` model role with a
 * short input (first request, previous recap, last user message, last
 * assistant reply; never tool output).
 */

const RULES = `Write exactly this, as plain text with no markdown and no preamble:
Line 1: the goal and where things stand now, in about 160 characters.
Line 2 (optional): "Next: " and then the open question waiting on the user, or the next step the user and the agent agreed on. Leave this line out if there is neither.
Rules: only state work the conversation shows as done; never claim results that aren't there. If the user corrected course, follow the latest correction, not the earlier plan. Write in the language the user writes in.`;

/** The user message appended to the main agent's request for a main-model recap. */
export const RECAP_REQUEST = `[recap] The user stepped away and is coming back to this conversation. Write a short recap for them; it is shown above their prompt and never enters this conversation. Don't continue the task and don't call tools.

${RULES}`;

/** The system prompt for the small-model recap. */
export const RECAP_SYSTEM = `You write a short recap of a coding session between a user and a coding agent, for the user who stepped away and is coming back. You see excerpts only: the first request, the previous recap if any, the last user message and the last agent reply.

${RULES}`;

export const LINE_MAX = 200;
export const NEXT_MAX = 160;

/** Line 1 and the optional `Next:` line from the model's reply, cleaned of markdown and labels. */
export function parseRecap(raw: string): { text: string; next?: string } | undefined {
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*>]\s+|#+\s+)?/, "").replace(/\*\*|__|`/g, "").trim())
    .filter(Boolean);
  let text: string | undefined;
  let next: string | undefined;
  for (const l of lines) {
    const n = /^(?:line\s*2\s*:\s*)?next\s*:\s*(.*)$/i.exec(l);
    if (n) {
      next ??= n[1]!.trim() || undefined;
      continue;
    }
    text ??= l.replace(/^(?:line\s*1|recap)\s*:\s*/i, "").trim() || undefined;
  }
  if (!text) return undefined;
  return { text: clip(text, LINE_MAX), ...(next ? { next: clip(next, NEXT_MAX) } : {}) };
}

/** Cuts at a word boundary near `max` and adds an ellipsis. */
export function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const userText = (m: AgentMessage): string | undefined => {
  const u = m as { role?: string; content?: unknown };
  if (u.role !== "user") return undefined;
  if (typeof u.content === "string") return u.content.trim();
  const blocks = Array.isArray(u.content) ? (u.content as { type: string; text?: string }[]) : [];
  return blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
};

const head = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n)}…`);
const tail = (s: string, n: number) => (s.length <= n ? s : `…${s.slice(-n)}`);

/** The small model's input: first request, previous recap, last user message (~1k chars), last agent reply (~1.5k chars). No tool output. */
export function smallInput(messages: readonly AgentMessage[], previous?: SavedRecap): string {
  const users = messages.map(userText).filter((t): t is string => Boolean(t));
  const reply = messages.findLast((m) => (m as { role?: string }).role === "assistant" && textOf(m as AssistantMessage));
  const parts: string[] = [];
  if (users[0]) parts.push(`<first_request>\n${head(users[0], 1000)}\n</first_request>`);
  if (previous) parts.push(`<previous_recap>\n${previous.text}${previous.next ? `\nNext: ${previous.next}` : ""}\n</previous_recap>`);
  if (users.length > 1) parts.push(`<last_user_message>\n${head(users.at(-1)!, 1000)}\n</last_user_message>`);
  if (reply) parts.push(`<last_agent_reply>\n${tail(textOf(reply as AssistantMessage), 1500)}\n</last_agent_reply>`);
  parts.push("Write the recap now.");
  return parts.join("\n\n");
}

export type StreamFn = (model: Model<Api>, context: Context, options: Record<string, unknown>) => AssistantMessageEventStream;
export type Usage = { input: number; cacheRead: number; output: number };
export type Generated = Omit<SavedRecap, "leafId">;

/** How long the main model's prompt cache stays warm, or undefined when nothing says it caches. */
export function cacheTtlMs(model: Model<Api>, observedCache: boolean, fallbackMs: number, env: NodeJS.ProcessEnv = process.env): number | undefined {
  const tier = env.PI_CACHE_RETENTION === "long" ? "long" : "short";
  const seconds = model.promptCache?.[tier];
  if (seconds !== undefined) return seconds * 1000;
  // Most catalogue models don't declare a lifetime; a cache read in this session shows the provider caches.
  return observedCache ? fallbackMs : undefined;
}

/**
 * Main model when a main request was seen in this process and its cache is
 * still warm; otherwise the small path. A resumed session has no captured
 * request (and an old cache), so it always takes the small path.
 */
export function chooseRoute(o: { model: Model<Api> | undefined; lastRequestAt: number | undefined; now: number; ttlMs: number | undefined }): "main" | "small" {
  if (!o.model || o.lastRequestAt === undefined || o.ttlMs === undefined) return "small";
  return o.now - o.lastRequestAt < o.ttlMs ? "main" : "small";
}

const modelName = (m: Model<Api>) => `${m.provider}/${m.id}`;

/** A side turn on the main model: the main agent's next request with the recap request appended, same session id and effort. */
export async function recapOnMainModel(
  prefix: AgentMessage[],
  o: { model: Model<Api>; sessionId: string; reasoning?: string; stream: StreamFn; signal?: AbortSignal },
): Promise<Generated> {
  const r = await ask(prefix, [], RECAP_REQUEST, {
    model: o.model,
    sessionId: o.sessionId,
    ...(o.reasoning ? { reasoning: o.reasoning } : {}),
    stream: o.stream,
    // Every main tool stays declared (dropping any would change the cached prefix); none runs.
    tools: [],
    refuse: () => "a recap runs no tools",
    preamble: "",
    maxSteps: 2,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (r.error) throw new Error(r.error);
  const parsed = parseRecap(r.answer);
  if (!parsed) throw new Error("the model returned no recap");
  return { ...parsed, model: modelName(o.model), route: "main", usage: r.usage };
}

/** The small-input path: one request with the excerpts, on the recap role's model. */
export async function recapOnSmallModel(input: string, o: { model: Model<Api>; reasoning?: string; stream: StreamFn; signal?: AbortSignal }): Promise<Generated> {
  const user: UserMessage = { role: "user", content: [{ type: "text", text: input }], timestamp: Date.now() };
  const context = normalizeContext({ systemPrompt: RECAP_SYSTEM, messages: [user] }) as unknown as Context;
  const stream = o.stream(o.model, context, {
    ...(o.reasoning && o.reasoning !== "off" ? { reasoning: o.reasoning } : {}),
    transport: "sse",
    ...(o.signal ? { signal: o.signal } : {}),
  });
  for await (const _ of stream) {
    // Drain; only the final message matters.
  }
  const reply = await stream.result();
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(reply.errorMessage ?? reply.stopReason);
  const parsed = parseRecap(textOf(reply));
  if (!parsed) throw new Error("the model returned no recap");
  const u = reply.usage;
  return { ...parsed, model: modelName(o.model), route: "small", usage: { input: u?.input ?? 0, cacheRead: u?.cacheRead ?? 0, output: u?.output ?? 0 } };
}
