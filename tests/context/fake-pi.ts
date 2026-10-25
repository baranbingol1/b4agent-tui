import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A stand-in for Pi's extension API that records handlers and commands, so tests can drive an extension's events. */
export function fakePi() {
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
  const api = {
    on(name: string, h: (event: any, ctx: any) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), h]);
      return () => {};
    },
    registerCommand(name: string, c: { handler: (args: string, ctx: any) => unknown }) {
      commands.set(name, c);
    },
  };
  return {
    pi: api as unknown as ExtensionAPI,
    commands,
    async emit(name: string, event: any, ctx: any): Promise<unknown> {
      let out: unknown;
      for (const h of handlers.get(name) ?? []) out = (await h(event, ctx)) ?? out;
      return out;
    },
  };
}

let n = 0;
const id = () => `e${++n}`;

/** A session branch built from messages, the shape `getBranch()` returns. */
export class Branch {
  entries: any[] = [];
  private push(e: any) {
    const entry = { id: id(), parentId: this.entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...e };
    this.entries.push(entry);
    return entry;
  }
  user(text: string) {
    return this.push({ type: "message", message: { role: "user", content: text, timestamp: Date.now() } });
  }
  call(toolCallId: string, name: string, args: Record<string, unknown>) {
    return this.push({
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name, arguments: args }], api: "faux", provider: "faux", model: "faux", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() },
    });
  }
  result(toolCallId: string, toolName: string, content: any[], isError = false) {
    return this.push({ type: "message", message: { role: "toolResult", toolCallId, toolName, content, isError, timestamp: Date.now() } });
  }
  compact(firstKeptEntryId: string) {
    return this.push({ type: "compaction", summary: "earlier work", firstKeptEntryId, tokensBefore: 1000 });
  }
}
