import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Context, Message, Model, Api, ToolCall, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";

/**
 * `/btw`: a side question to the main agent that never enters the main
 * conversation. To reuse the main session's prompt cache it sends the same
 * request the main agent's next turn would send (same model, system message,
 * tool declarations and message prefix, same prompt-cache key), with the
 * question appended as a user message. Read-only enforcement therefore can't
 * drop tools from the request: the model sees every main tool, and only
 * read-only calls run.
 */

/** What the main agent last sent, plus what it appended since. */
export class MainTranscript {
  /** The transcript of the last main request, after every `context` transform. */
  private sent: AgentMessage[] | undefined;
  /** Messages the main agent appended after that request: its reply, tool results, queued messages. */
  private after: AgentMessage[] = [];

  onRequest(messages: AgentMessage[]): void {
    this.sent = messages;
    this.after = [];
  }

  onMessage(message: AgentMessage): void {
    if (this.sent) this.after.push(message);
  }

  /** The session changed under us (switch, tree navigation, compaction): rebuild from entries next time. */
  reset(): void {
    this.sent = undefined;
    this.after = [];
  }

  /**
   * The main conversation up to now, as the main agent would send it.
   * `fallback` rebuilds it from the session when no request was seen yet
   * (a resumed session), without other extensions' `context` transforms.
   */
  snapshot(fallback: () => AgentMessage[]): AgentMessage[] {
    const messages = this.sent ? [...this.sent, ...this.after] : fallback();
    return withoutOpenToolCalls(messages);
  }
}

/**
 * A provider rejects a user message after tool calls that have no results yet
 * (the main agent is mid-step), so an unfinished last step is left out. The
 * cached prefix ends before it anyway.
 */
export function withoutOpenToolCalls(messages: AgentMessage[]): AgentMessage[] {
  const lastAssistant = messages.findLastIndex((m) => (m as { role?: string }).role === "assistant");
  if (lastAssistant < 0) return messages;
  const calls = ((messages[lastAssistant] as AssistantMessage).content ?? []).filter((c): c is ToolCall => c.type === "toolCall");
  if (!calls.length) return messages;
  const answered = new Set(messages.slice(lastAssistant + 1).flatMap((m) => ((m as ToolResultMessage).role === "toolResult" ? [(m as ToolResultMessage).toolCallId] : [])));
  return calls.every((c) => answered.has(c.id)) ? messages : messages.slice(0, lastAssistant);
}

export const BTW_PREAMBLE = `[/btw side chat] The user is asking you a side question in a separate side chat. You see the main conversation up to this point, but nothing in this side chat enters it: the main agent won't see your answer, and the main task goes on without it. Answer the question directly and briefly; don't continue the main task. Only read-only tools run here (read, grep, find, ls, and bash commands the permission rules treat as read-only); any other call is refused.`;

export interface SideTurn {
  question: string;
  answer: string;
}

/** The request messages for one question: the main prefix, the side chat so far, then the question. */
export function questionMessages(prefix: AgentMessage[], history: AgentMessage[], question: string, preamble = BTW_PREAMBLE): AgentMessage[] {
  const first = history.length === 0;
  const text = first && preamble ? `${preamble}\n\n${question}` : question;
  const user: UserMessage = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
  return [...prefix, ...history, user];
}

export interface AskOptions {
  model: Model<Api>;
  /** The main session's id: providers key their prompt cache on it (`prompt_cache_key`). */
  sessionId: string;
  reasoning?: string;
  stream: (model: Model<Api>, context: Context, options: Record<string, unknown>) => AssistantMessageEventStream;
  tools: AgentTool[];
  /** Why a call may not run here, or undefined when it may. */
  refuse: (tool: string, input: Record<string, unknown>) => string | undefined;
  signal?: AbortSignal;
  onUpdate?: (messages: AgentMessage[], partial?: AssistantMessage) => void;
  maxSteps?: number;
  /** Replaces the /btw note before the first question (the thread recap sends its own instructions; "" for none). */
  preamble?: string;
}

export interface AskResult {
  /** The messages this question added after the main prefix and earlier side turns. */
  added: AgentMessage[];
  answer: string;
  error?: string;
  usage: { input: number; cacheRead: number; output: number };
}

/** Runs one side question to its answer, executing read-only tool calls on the way. */
export async function ask(prefix: AgentMessage[], history: AgentMessage[], question: string, o: AskOptions): Promise<AskResult> {
  const messages = questionMessages(prefix, history, question, o.preamble);
  const start = prefix.length + history.length;
  const usage = { input: 0, cacheRead: 0, output: 0 };
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const added = () => messages.slice(start);
  for (let step = 0; step < (o.maxSteps ?? 16); step++) {
    const context = normalizeContext({ messages: convertToLlm(messages) as Message[] }) as unknown as Context;
    const stream = o.stream(o.model, context, {
      sessionId: o.sessionId,
      ...(o.reasoning && o.reasoning !== "off" ? { reasoning: o.reasoning } : {}),
      // The main session may hold a WebSocket for this session id with its own continuation state; stay off it.
      transport: "sse",
      ...(o.signal ? { signal: o.signal } : {}),
    });
    for await (const e of stream) if ("partial" in e && e.partial) o.onUpdate?.(added(), e.partial);
    const reply = await stream.result();
    messages.push(reply);
    usage.input += reply.usage?.input ?? 0;
    usage.cacheRead += reply.usage?.cacheRead ?? 0;
    usage.output += reply.usage?.output ?? 0;
    o.onUpdate?.(added());
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      return { added: added(), answer: textOf(reply), error: reply.errorMessage ?? reply.stopReason, usage };
    }
    const calls = reply.content.filter((c): c is ToolCall => c.type === "toolCall");
    if (!calls.length) return { added: added(), answer: textOf(reply), usage };
    for (const call of calls) {
      messages.push(await runTool(call, byName, o));
      o.onUpdate?.(added());
    }
  }
  return { added: added(), answer: "", error: "stopped after too many tool steps", usage };
}

async function runTool(call: ToolCall, tools: Map<string, AgentTool>, o: AskOptions): Promise<ToolResultMessage> {
  const result = (text: string, isError: boolean, content?: ToolResultMessage["content"]): ToolResultMessage =>
    ({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: content ?? [{ type: "text", text }], isError, timestamp: Date.now() }) as ToolResultMessage;
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  const tool = tools.get(call.name);
  if (!tool) return result(`${call.name} isn't available in a /btw side chat, which is read-only. Answer from what you know or use read, grep, find, ls or read-only bash.`, true);
  const why = o.refuse(call.name, args);
  if (why) return result(`Refused in the /btw side chat (read-only): ${why}`, true);
  try {
    const r = await tool.execute(call.id, args as never, o.signal);
    return result("", false, r.content);
  } catch (e) {
    return result((e as Error).message, true);
  }
}

export function textOf(m: AssistantMessage): string {
  return m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n").trim();
}
