import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, AssistantMessageEventStream, Context, Model, Api } from "@earendil-works/pi-ai";
import {
  buildSessionContext, createBashTool, createFindTool, createGrepTool, createLsTool, createReadTool,
  type ExtensionAPI, type ExtensionContext, type SessionEntry, type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Component, Input, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { ask, MainTranscript, textOf, type AskResult } from "../btw/side-chat.js";
import type { Verdict } from "../permissions/types.js";

export const BTW_ENTRY = "b4agent-btw";

export interface BtwOptions {
  /** The permission rules' verdict for a call, so read-only bash goes through the same gate. */
  classify: (tool: string, input: Record<string, unknown>, ctx: ExtensionContext) => Verdict;
}

interface Turn {
  question: string;
  answer: string;
  error?: string;
  usage?: AskResult["usage"];
  running?: boolean;
}

/** One side chat: a frozen view of the main conversation, then its own questions and answers. */
interface Chat {
  id: string;
  prefix: AgentMessage[] | undefined;
  /** The side chat's own messages after the prefix, sent with every follow-up. */
  history: AgentMessage[];
  turns: Turn[];
  /** Live messages of the question being answered, for the view. */
  live: AgentMessage[];
  partial?: AssistantMessage;
  abort?: AbortController;
}

export interface BtwHandle {
  /** Asks in the current side chat, starting one from the main conversation's current point if there is none. */
  ask(ctx: ExtensionContext, question: string, opts?: { fresh?: boolean }): Promise<Turn>;
}

/**
 * `/btw <question>` starts a side chat that sees the main conversation up to
 * now; `/btw` reopens the last one. The overlay keeps asking in the same chat.
 * Questions and answers are saved with `appendEntry`, which never reaches the
 * model; nothing is sent to the main conversation.
 */
export default function btw(pi: ExtensionAPI, opts: BtwOptions): BtwHandle {
  const main = new MainTranscript();
  let chat: Chat | undefined;
  let view: { refresh(): void } | undefined;

  pi.on("context_with_system", (e) => {
    main.onRequest(e.messages);
    return undefined;
  });
  pi.on("message_end", (e) => main.onMessage(e.message));
  // The view of the main conversation is rebuilt after anything that rewrites it.
  pi.on("session_start", () => {
    main.reset();
    chat = undefined;
  });
  pi.on("session_tree", () => {
    main.reset();
    chat = undefined;
  });
  pi.on("session_compact", () => main.reset());

  const fallback = (ctx: ExtensionContext) => () =>
    buildSessionContext(ctx.sessionManager.getEntries() as SessionEntry[], ctx.sessionManager.getLeafId()).messages;

  const newChat = (ctx: ExtensionContext): Chat => ({ id: `btw-${Date.now().toString(36)}`, prefix: main.snapshot(fallback(ctx)), history: [], turns: [], live: [] });

  /** A side chat restored from saved entries has no prefix or history in memory; rebuild them from its text. */
  const restore = (ctx: ExtensionContext): Chat | undefined => {
    const saved = ctx.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === BTW_ENTRY).map((e) => (e as { data?: Turn & { chat?: string } }).data!);
    const last = saved.at(-1)?.chat;
    if (!last) return undefined;
    const turns = saved.filter((t) => t.chat === last).map(({ question, answer, error }) => ({ question, answer, ...(error ? { error } : {}) }));
    return { id: last, prefix: undefined, history: [], turns, live: [] };
  };

  const run = async (ctx: ExtensionContext, c: Chat, question: string): Promise<Turn> => {
    const model = ctx.model;
    const turn: Turn = { question, answer: "", running: true };
    c.turns.push(turn);
    view?.refresh();
    if (!model) {
      Object.assign(turn, { running: false, error: "no model selected" });
      return turn;
    }
    if (!c.prefix) {
      // Restored chat: see the main conversation as it is now, and the earlier side turns as plain text.
      c.prefix = main.snapshot(fallback(ctx));
      c.history = c.turns.slice(0, -1).flatMap((t) => textTurn(t, model));
    }
    c.abort = new AbortController();
    const cwd = ctx.cwd;
    const tools: AgentTool[] = [createReadTool(cwd), createGrepTool(cwd), createFindTool(cwd), createLsTool(cwd), createBashTool(cwd)] as AgentTool[];
    try {
      const r = await ask(c.prefix, c.history, question, {
        model,
        sessionId: ctx.sessionManager.getSessionId(),
        ...(ctx.thinkingLevel ? { reasoning: ctx.thinkingLevel } : {}),
        stream: (m: Model<Api>, context: Context, o: Record<string, unknown>): AssistantMessageEventStream => ctx.modelRegistry.streamSimple(m, context, o),
        tools,
        refuse: (tool, input) => {
          const v = opts.classify(tool, input, ctx);
          return v.level === "allow" ? undefined : `${v.reason} (${v.rule})`;
        },
        signal: c.abort.signal,
        onUpdate: (messages, partial) => {
          c.live = messages;
          c.partial = partial;
          view?.refresh();
        },
      });
      c.history.push(...r.added);
      Object.assign(turn, { answer: r.answer, usage: r.usage, ...(r.error ? { error: r.error } : {}) });
    } catch (e) {
      turn.error = (e as Error).message;
    } finally {
      turn.running = false;
      c.live = [];
      c.partial = undefined;
      c.abort = undefined;
      view?.refresh();
    }
    pi.appendEntry(BTW_ENTRY, { chat: c.id, question, answer: turn.answer, model: `${model.provider}/${model.id}`, ...(turn.usage ? { usage: turn.usage } : {}), ...(turn.error ? { error: turn.error } : {}) });
    return turn;
  };

  const handle: BtwHandle = {
    async ask(ctx, question, o = {}) {
      if (o.fresh || !chat) chat = newChat(ctx);
      return run(ctx, chat, question);
    },
  };

  pi.registerCommand("btw", {
    description: "Ask a side question that never enters the main conversation (/btw alone reopens the last side chat)",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question) chat = newChat(ctx);
      else chat ??= restore(ctx) ?? newChat(ctx);
      const c = chat;
      if (!ctx.hasUI) {
        if (!question) return;
        const t = await run(ctx, c, question);
        ctx.ui.notify(t.error ? `btw failed: ${t.error}` : t.answer, t.error ? "error" : "info");
        return;
      }
      if (question) void run(ctx, c, question);
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => {
          const v = new SideChatView(c, tui, theme, (q) => void run(ctx, c, q), () => {
            view = undefined;
            done();
          });
          view = v;
          return v;
        },
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
      );
    },
  });

  return handle;
}

/** An earlier side turn as plain user and assistant text, for a chat restored after a reload. */
function textTurn(t: Turn, model: Model<Api>): AgentMessage[] {
  if (!t.answer) return [];
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return [
    { role: "user", content: [{ type: "text", text: t.question }], timestamp: 0 },
    { role: "assistant", content: [{ type: "text", text: t.answer }], api: model.api, provider: model.provider, model: model.id, usage: zero, stopReason: "stop", timestamp: 0 } as AgentMessage,
  ];
}

class SideChatView implements Component {
  private readonly input = new Input({ prompt: "› " });
  private scroll = 0;
  private note: string | undefined;
  focused = true;

  constructor(
    private readonly chat: Chat,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly submit: (question: string) => void,
    private readonly close: () => void,
  ) {
    this.input.focused = true;
    this.input.onSubmit = (v) => {
      const q = v.trim();
      if (!q) return;
      if (this.chat.turns.at(-1)?.running) {
        this.note = "wait for the answer, or ctrl+c to stop it";
        return;
      }
      this.input.setValue("");
      this.scroll = 0;
      this.note = undefined;
      this.submit(q);
    };
  }

  refresh() {
    this.tui.requestRender();
  }

  invalidate() {}

  handleInput(data: string) {
    if (matchesKey(data, "escape")) {
      this.close();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (this.chat.abort) this.chat.abort.abort();
      else this.close();
      return;
    }
    if (matchesKey(data, "pageUp")) this.scroll += 10;
    else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 10);
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(20, width - 4);
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    const border = (s: string) => t.fg("borderAccent", s);
    const pad = (s: string) => {
      const cut = truncateToWidth(s, inner);
      return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
    };
    const title = " btw · side chat · sees the main conversation up to when it started · never enters it ";
    const shown = truncateToWidth(title, inner - 2);
    const top = border("╭─") + t.bold(shown) + border("─".repeat(Math.max(0, inner - visibleWidth(shown))) + "╮");

    const body: string[] = [];
    for (const l of this.lines()) body.push(...(l ? wrapTextWithAnsi(l, inner) : [""]));
    const room = height - 4;
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
    const end = body.length - this.scroll;
    const view = body.slice(Math.max(0, end - room), end);
    while (view.length < room) view.unshift("");
    const running = this.chat.turns.at(-1)?.running;
    const hint = this.note ?? `enter ask · ${running ? "ctrl+c stop · " : ""}pgup/pgdn scroll${this.scroll ? ` (${this.scroll} up)` : ""} · esc close (/btw reopens)`;
    return [top, ...view.map(pad), pad(t.fg("dim", "─".repeat(inner))), pad(this.input.render(inner)[0] ?? ""), pad(t.fg("dim", hint)), border(`╰${"─".repeat(inner + 2)}╯`)];
  }

  private lines(): string[] {
    const t = this.theme;
    const out: string[] = [];
    if (!this.chat.turns.length) out.push(t.fg("dim", "Ask anything about the work so far. Only read-only tools run here."));
    for (const turn of this.chat.turns) {
      out.push("", t.fg("userMessageText", `› ${turn.question}`));
      if (turn.running) {
        for (const m of this.chat.live as { role: string; content?: unknown; isError?: boolean }[]) {
          if (m.role === "assistant") out.push(...steps(m.content, t));
          else if (m.role === "toolResult") out.push(t.fg(m.isError ? "error" : "dim", `  ${m.isError ? "✗" : "←"} ${firstLine(m.content)}`));
        }
        const p = this.chat.partial;
        if (p) {
          out.push(...steps(p.content, t));
          const text = textOf(p);
          if (text) out.push("", text);
        }
        out.push(t.fg("muted", "… thinking"));
        continue;
      }
      if (turn.answer) out.push("", turn.answer);
      if (turn.error) out.push(t.fg("error", `btw failed: ${turn.error}`));
    }
    return out;
  }
}

function steps(content: unknown, t: Theme): string[] {
  const out: string[] = [];
  for (const b of (Array.isArray(content) ? content : []) as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
    if (b.type !== "toolCall") continue;
    const a = b.arguments ?? {};
    const arg = ["command", "path", "pattern"].map((k) => a[k]).find((x) => typeof x === "string") as string | undefined;
    out.push(t.fg("toolTitle", `→ ${b.name} ${(arg ?? "").split("\n")[0]!.slice(0, 120)}`));
  }
  return out;
}

function firstLine(content: unknown): string {
  const text = (Array.isArray(content) ? content : []).map((c: { type: string; text?: string }) => (c.type === "text" ? c.text ?? "" : "")).join(" ");
  return text.trim().split("\n")[0]?.slice(0, 160) ?? "";
}
