/**
 * Test-only extension for tests/e2e/tui.sh (not a vitest file):
 * - a faux `openai-codex/gpt-faux` reasoning model, so the footer's cold-cache
 *   hint and autotitle run end to end without a login. It answers a title
 *   request with a fixed title and anything else with one line.
 * - a focus probe: shows `probe: away` / `probe: back` as a status chip from
 *   `onAwayChange`, i.e. from the raw stdin listener in src/tui/focus.ts.
 */
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { onAwayChange } from "../../src/tui/focus.js";

export default function probe(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-faux", name: "Faux GPT", reasoning: true }] });
  faux.setResponses(
    Array.from({ length: 200 }, () => (context: { messages: { role: string; content: unknown }[] }) => {
      const last = context.messages.at(-1);
      const c = last?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "";
      return fauxAssistantMessage(fauxText(text.includes("Write a title") ? "Footer chips for the faux run" : `FAUX REPLY to ${text}`));
    }),
  );
  pi.registerProvider(faux.provider);

  let off: (() => void) | undefined;
  let bells = 0;
  let title = "";
  let wrapped = false;
  pi.on("session_start", (_e, ctx) => {
    off?.();
    if (ctx.mode !== "tui") return;
    off = onAwayChange((away) => ctx.ui.setStatus("zz.probe", away ? "probe: away" : "probe: back"));
    if (wrapped) return;
    wrapped = true;
    // The bell and the title are bytes on stdout, which tuistory doesn't show: count them into a chip.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") {
        if (chunk === "\x07") bells++;
        const t = /\x1b\]0;([^\x07]*)\x07/.exec(chunk);
        if (t) title = t[1]!;
        if (chunk === "\x07" || t) setImmediate(() => ctx.ui.setStatus("zz.probe-out", `bells ${bells} · title ${title}`));
      }
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
  });
}
