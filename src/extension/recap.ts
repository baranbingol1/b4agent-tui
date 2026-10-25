import { appendFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import { buildSessionContext, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { MainTranscript } from "../btw/side-chat.js";
import { loadB4Config, resolveModel } from "../config.js";
import { RecapController } from "../recap/controller.js";
import { cacheTtlMs, chooseRoute, type Generated, recapOnMainModel, recapOnSmallModel, smallInput, type StreamFn } from "../recap/generate.js";
import { loadRecapSettings, readConversation, RECAP_ENTRY, type RecapSettings, type SavedRecap } from "../recap/trigger.js";
import { recapLines } from "../recap/widget.js";

export const RECAP_WIDGET = "recap";
export const RECAP_STATUS = "b4agent.recap";

export interface RecapOptions {
  /** Overrides for tests: the clock and timers, and the settings. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  settings?: Partial<RecapSettings>;
}

export interface RecapHandle {
  controller(): RecapController | undefined;
  /** Writes a recap for the conversation as it is now, through the same route choice as away mode (no UI, no save). */
  generate(ctx: ExtensionContext, signal?: AbortSignal): Promise<Generated>;
}

/**
 * Thread recap (plan section 3), main session only and interactive (TUI)
 * only. After a clean run, no keystrokes for `awayMs` writes a recap in the
 * background; it shows above the editor, dim, until the user types or sends.
 * Saved with `appendEntry("recap", …)`, which never reaches the model.
 */
export default function recap(pi: ExtensionAPI, opts: RecapOptions = {}): RecapHandle {
  const now = opts.now ?? Date.now;
  const main = new MainTranscript();
  let lastRequestAt: number | undefined;
  let prompts = 0;
  let controller: RecapController | undefined;
  let unlisten: (() => void) | undefined;
  let settings: RecapSettings = loadRecapSettings();
  const log = (m: string) => {
    const file = process.env.B4AGENT_RECAP_LOG;
    if (file) appendFileSync(file, `${new Date(now()).toISOString()} ${m}\n`);
  };

  // The main agent's request as sent (the /btw capture): the main-model recap appends to exactly this.
  pi.on("context_with_system", (e) => {
    main.onRequest(e.messages);
    lastRequestAt = now();
    return undefined;
  });
  pi.on("message_end", (e) => main.onMessage(e.message));
  pi.on("session_compact", () => main.reset());
  pi.on("session_tree", () => {
    main.reset();
    controller?.moved();
  });
  pi.on("ui_prompt_start", () => void prompts++);
  pi.on("ui_prompt_end", () => void (prompts = Math.max(0, prompts - 1)));

  const generate = async (ctx: ExtensionContext, signal?: AbortSignal, conversation = readConversation(ctx.sessionManager.getBranch())): Promise<Generated> => {
    const model = ctx.model as Model<Api> | undefined;
    const stream: StreamFn = (m: Model<Api>, context: Context, o: Record<string, unknown>): AssistantMessageEventStream => ctx.modelRegistry.streamSimple(m, context, o);
    const branch = ctx.sessionManager.getBranch() as SessionEntry[];
    const observed = Boolean(model) && branch.some((e) => {
      if (e.type !== "message") return false;
      const m = e.message as { role?: string; provider?: string; model?: string; usage?: { cacheRead?: number } };
      return m.role === "assistant" && m.provider === model!.provider && m.model === model!.id && (m.usage?.cacheRead ?? 0) > 0;
    });
    const ttlMs = model ? cacheTtlMs(model, observed, settings.cacheTtlMs) : undefined;
    const route = chooseRoute({ model, lastRequestAt, now: now(), ttlMs });
    log(`recap route ${route} (model ${model ? `${model.provider}/${model.id}` : "none"}, cache ${ttlMs === undefined ? "unknown" : `${ttlMs / 1000}s`}, last request ${lastRequestAt === undefined ? "none" : `${Math.round((now() - lastRequestAt) / 1000)}s ago`})`);
    if (route === "main" && model) {
      try {
        const prefix = main.snapshot(() => buildSessionContext(branch, ctx.sessionManager.getLeafId()).messages);
        return await recapOnMainModel(prefix, {
          model,
          sessionId: ctx.sessionManager.getSessionId(),
          ...(ctx.thinkingLevel ? { reasoning: ctx.thinkingLevel } : {}),
          stream,
          ...(signal ? { signal } : {}),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        log(`main-model recap failed, using the small path: ${(e as Error).message}`);
      }
    }
    const resolved = resolveModel("@recap", loadB4Config().roles, ctx.modelRegistry);
    const small = resolved?.model ?? model;
    if (!small) throw new Error("no model for the recap");
    const reasoning = resolved ? resolved.thinking : ctx.thinkingLevel;
    const messages = branch.flatMap((e) => (e.type === "message" ? [e.message as AgentMessage] : []));
    return recapOnSmallModel(smallInput(messages, conversation.lastRecap), { model: small, ...(reasoning ? { reasoning } : {}), stream, ...(signal ? { signal } : {}) });
  };

  const stop = (ctx?: ExtensionContext) => {
    controller?.dispose();
    controller = undefined;
    unlisten?.();
    unlisten = undefined;
    if (ctx?.hasUI) {
      ctx.ui.setWidget(RECAP_WIDGET, undefined);
      ctx.ui.setStatus(RECAP_STATUS, undefined);
    }
  };

  pi.on("session_start", (e, ctx) => {
    stop(ctx);
    main.reset();
    lastRequestAt = undefined;
    prompts = 0;
    if (!ctx.hasUI || ctx.mode !== "tui") return;
    const errors: string[] = [];
    settings = { ...loadRecapSettings(process.env, undefined, errors), ...opts.settings };
    for (const err of errors) ctx.ui.notify(`recap: ${err}`, "warning");
    if (!settings.enabled) return;
    const c = new RecapController(
      {
        now,
        setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
        clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
        conversation: () => readConversation(ctx.sessionManager.getBranch()),
        draft: () => ctx.ui.getEditorText(),
        idle: () => ctx.isIdle() && !ctx.hasPendingMessages() && prompts === 0,
        generate: (conv, signal) => generate(ctx, signal, conv),
        show: (r) =>
          ctx.ui.setWidget(
            RECAP_WIDGET,
            r ? (_tui, theme) => ({ render: (width: number) => recapLines(r, width, theme), invalidate() {} }) : undefined,
            { placement: "aboveEditor" },
          ),
        status: (text) => ctx.ui.setStatus(RECAP_STATUS, text),
        save: (r: SavedRecap) => {
          pi.appendEntry(RECAP_ENTRY, r);
          log(`recap saved (${r.route}, ${r.model}, cacheRead ${r.usage?.cacheRead ?? 0}): ${r.text}${r.next ? ` | Next: ${r.next}` : ""}`);
        },
        log,
      },
      settings,
    );
    controller = c;
    unlisten = ctx.ui.onTerminalInput((data) => {
      c.input(data);
      return undefined;
    });
    c.sessionStart(e.reason);
  });
  pi.on("session_shutdown", (_e, ctx) => stop(ctx));
  pi.on("input", () => {
    controller?.sent();
    return { action: "continue" };
  });
  pi.on("agent_start", () => controller?.agentStart());
  pi.on("agent_settled", (e) => controller?.settled(e.aborted));

  return { controller: () => controller, generate: (ctx, signal) => generate(ctx, signal) };
}
