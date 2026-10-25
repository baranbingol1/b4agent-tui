import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadB4Config, resolveModel } from "../config.js";
import { b4agentDir } from "../permissions/config.js";
import { loadTuiSettings } from "../tui/settings.js";
import { logSideUsage } from "../usage-log.js";

/**
 * Names an unnamed session from its first prompt, with a small model (the
 * `title` role, else `smol`), in the background while the agent works. It
 * never overrides a name the user gave, and does nothing when no small model
 * has a login (the main model would be a costly way to write five words).
 */

const MAX_INPUT = 4000;

export function titlePrompt(firstPrompt: string): string {
  return `Write a title for a coding-agent session that starts with the request below. At most 8 words, no quotes, no trailing punctuation, in the request's language. Reply with the title only.\n\n<request>\n${firstPrompt.slice(0, MAX_INPUT)}\n</request>`;
}

/** The model's reply as a title: one line, no wrapping quotes or final period, at most 80 characters; empty when unusable. */
export function cleanTitle(reply: string): string {
  const line = reply.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  return line
    .replace(/^(title|başlık)\s*:\s*/i, "")
    .replace(/^["'`“”‘’«»*_]+|["'`“”‘’«»*_.。!]+$/g, "")
    .trim()
    .slice(0, 80)
    .trim();
}

export default function autotitle(pi: ExtensionAPI) {
  let tried = false;
  pi.on("session_start", () => {
    tried = false;
  });

  pi.on("before_agent_start", (event, ctx) => {
    if (tried || event.messageType !== "user" || !event.prompt.trim()) return;
    tried = true;
    if (pi.getSessionName() || !loadTuiSettings().autotitle) return;
    void name(ctx, event.prompt);
  });

  async function name(ctx: ExtensionContext, prompt: string) {
    try {
      const roles = loadB4Config(b4agentDir()).roles;
      const r = (roles.title ? resolveModel("@title", roles, ctx.modelRegistry) : undefined) ?? resolveModel("@smol", roles, ctx.modelRegistry);
      if (!r) return;
      const stream = ctx.modelRegistry.streamSimple(
        r.model,
        { messages: [{ role: "user", content: titlePrompt(prompt), timestamp: Date.now() }] },
        { maxTokens: 400, timeoutMs: 20_000, maxRetries: 1, cacheRetention: "none", ...(r.model.reasoning && r.thinking !== "off" ? { reasoning: r.thinking ?? "minimal" } : {}) },
      );
      const reply: AssistantMessage = await stream.result();
      logSideUsage("autotitle", `${r.model.provider}/${r.model.id}`, reply.usage);
      if (reply.stopReason === "error" || reply.stopReason === "aborted") return;
      const title = cleanTitle(reply.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
      // The user may have named it meanwhile.
      if (title && !pi.getSessionName()) pi.setSessionName(title);
    } catch {
      // A missing title is not worth an error.
    }
  }
}
