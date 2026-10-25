/**
 * Writes Pi 1.3 session files (the format of SessionManager's JSONL: a
 * `session` header, then entries chained by parentId) into a temp agent dir,
 * in the folders Pi would use for each cwd.
 */
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirName } from "../../src/history/paths.js";

export type Turn =
  | { user: string }
  | { assistant: string; calls?: { name: string; args: Record<string, unknown>; result?: string; error?: boolean }[] }
  | { name: string }
  | { compaction: string }
  /** The next entry continues from the entry with this index (0 = first entry after the header). */
  | { branchFrom: number };

let counter = 0;
const hex = (n: number) => n.toString(16).padStart(8, "0");

export function writeSession(sessionsRoot: string, opts: { cwd: string; id: string; start: string; turns: Turn[]; minutesPerEntry?: number; dir?: string }): string {
  const dir = opts.dir ?? join(sessionsRoot, sessionDirName(opts.cwd));
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse(opts.start);
  const step = (opts.minutesPerEntry ?? 1) * 60_000;
  const lines: string[] = [JSON.stringify({ type: "session", version: 3, id: opts.id, timestamp: new Date(t0).toISOString(), cwd: opts.cwd })];
  const ids: string[] = [];
  let parent: string | null = null;
  let k = 0;
  const push = (e: Record<string, unknown>) => {
    const id = hex(++counter);
    const ts = t0 + ++k * step;
    lines.push(JSON.stringify({ ...e, id, parentId: parent, timestamp: new Date(ts).toISOString() }));
    ids.push(id);
    parent = id;
    return ts;
  };
  for (const turn of opts.turns) {
    if ("branchFrom" in turn) {
      parent = ids[turn.branchFrom]!;
      continue;
    }
    if ("user" in turn) {
      const ts = t0 + (k + 1) * step;
      push({ type: "message", message: { role: "user", content: [{ type: "text", text: turn.user }], timestamp: ts } });
    } else if ("name" in turn) push({ type: "session_info", name: turn.name });
    else if ("compaction" in turn) push({ type: "compaction", summary: turn.compaction, firstKeptEntryId: ids[0] ?? "x", tokensBefore: 1000 });
    else {
      const callIds = (turn.calls ?? []).map((_, i) => `call_${counter}_${i}`);
      const ts = t0 + (k + 1) * step;
      push({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: turn.assistant }, ...(turn.calls ?? []).map((c, i) => ({ type: "toolCall", id: callIds[i], name: c.name, arguments: c.args }))],
          api: "faux", provider: "faux", model: "faux", usage: {}, stopReason: turn.calls?.length ? "toolUse" : "stop", timestamp: ts,
        },
      });
      (turn.calls ?? []).forEach((c, i) => {
        const rts = t0 + (k + 1) * step;
        push({ type: "message", message: { role: "toolResult", toolCallId: callIds[i], toolName: c.name, content: [{ type: "text", text: c.result ?? "ok" }], isError: Boolean(c.error), timestamp: rts } });
      });
    }
  }
  const file = join(dir, `${opts.start.replace(/[:.]/g, "-")}_${opts.id}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  // mtime = the last entry's time, as when Pi appended it.
  const last = new Date(t0 + k * step);
  utimesSync(file, last, last);
  return file;
}
