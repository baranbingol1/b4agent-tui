/**
 * A scripted "model" for end-to-end tests: each user prompt maps to fixed
 * tool calls (from the JSON file in B4_SCRIPT), so the gate sees exact
 * commands and no real agent improvises. After the tool results it replies
 * with one line per result, which the tests read.
 *
 *   pi -e src/extension/permissions.ts -e tests/e2e/scripted-model.ts --model script/agent
 */
import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxResponseFactory, type JsonObject } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Call = { tool: string; args: JsonObject };
/** A prompt maps to one batch of tool calls, or to several batches run one after another. */
type Script = Record<string, Call[] | Call[][]>;

export default function scriptedModel(pi: ExtensionAPI) {
  const script = JSON.parse(readFileSync(process.env.B4_SCRIPT ?? "", "utf8")) as Script;
  const faux = fauxProvider({ provider: "script", models: [{ id: "agent", name: "Scripted agent" }] });
  const step: FauxResponseFactory = (context) => {
    const messages = context.messages;
    const userAt = messages.findLastIndex((m) => m.role === "user");
    const user = messages[userAt];
    const prompt = typeof user?.content === "string" ? user.content : (user?.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("");
    // Subagent briefs start with a header ("main started you as …") and deliveries with "[name finished]", so a key may match the end or the start.
    const key = prompt.trim();
    const entry = script[key] ?? Object.entries(script).find(([k]) => key.endsWith(`\n${k}`) || key.startsWith(k))?.[1];
    const steps: Call[][] = !entry ? [] : Array.isArray(entry[0]) ? (entry as Call[][]) : [entry as Call[]];
    const done = messages.slice(userAt + 1).filter((m) => m.role === "assistant").length;
    if (done < steps.length) return fauxAssistantMessage(steps[done]!.map((c) => fauxToolCall(c.tool, c.args)), { stopReason: "toolUse" });
    const last = messages.at(-1);
    if (last?.role === "toolResult") {
      const results = messages.slice(messages.findLastIndex((m) => m.role === "assistant") + 1).filter((m) => m.role === "toolResult");
      const lines = results.map((r) => {
        const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join(" ").replace(/\s+/g, " ").slice(0, 300);
        return `RESULT ${r.toolName} ${r.isError ? "ERROR" : "OK"}: ${text}`;
      });
      return fauxAssistantMessage(fauxText(lines.join("\n")));
    }
    return fauxAssistantMessage(fauxText(`NO SCRIPT for: ${key.replace(/\s+/g, " ").slice(0, 300)}`));
  };
  faux.setResponses(Array.from({ length: 500 }, () => step));
  pi.registerProvider(faux.provider);
}
