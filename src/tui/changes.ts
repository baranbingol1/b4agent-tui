/**
 * Lines added and removed per file on the current branch: the footer's
 * `Δ2 +14 −3` chip and the `/changes` table. Counted from the edit and write
 * tool results in the session, so it follows `/tree` and resumes.
 */
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import type { Styler } from "./footer.js";

export interface FileChurn {
  path: string;
  added: number;
  removed: number;
  lastTouched: number;
}

/** `+` and `-` lines of a unified patch, headers excluded. */
export function countPatch(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Forward slashes, relative to cwd when inside it. */
export function displayPath(path: string, cwd: string): string {
  const p = path.replace(/\\/g, "/");
  const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : p;
}

export class ChangeLog {
  private readonly files = new Map<string, FileChurn>();

  clear(): void {
    this.files.clear();
  }

  /** One successful edit or write. `details` is the edit tool's result details (its `patch`). */
  record(tool: string, input: Record<string, unknown>, details: unknown, when: number, cwd: string): boolean {
    const raw = typeof input.path === "string" ? input.path : undefined;
    if (!raw) return false;
    let delta: { added: number; removed: number } | undefined;
    if (tool === "edit") {
      const patch = (details as { patch?: unknown } | undefined)?.patch;
      if (typeof patch === "string") delta = countPatch(patch);
    } else if (tool === "write") {
      const c = typeof input.content === "string" ? input.content : "";
      // A write may replace a whole file; without the old content, every line counts as added.
      delta = { added: c.length ? c.replace(/\n$/, "").split("\n").length : 0, removed: 0 };
    }
    if (!delta) return false;
    const path = displayPath(raw, cwd);
    const f = this.files.get(path) ?? { path, added: 0, removed: 0, lastTouched: 0 };
    f.added += delta.added;
    f.removed += delta.removed;
    f.lastTouched = Math.max(f.lastTouched, when);
    this.files.set(path, f);
    return true;
  }

  /** Rebuild from a branch's entries: tool calls in assistant messages, matched to their successful results. */
  rebuild(entries: readonly unknown[], cwd: string): void {
    this.clear();
    const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
    for (const raw of entries) {
      const e = raw as { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: unknown; timestamp?: number } };
      const m = e.message;
      if (e.type !== "message" || !m) continue;
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
          if (part.type === "toolCall" && part.id && part.name) calls.set(part.id, { name: part.name, args: part.arguments ?? {} });
        }
      } else if (m.role === "toolResult" && !m.isError && m.toolCallId) {
        const call = calls.get(m.toolCallId);
        if (call) this.record(call.name, call.args, m.details, m.timestamp ?? 0, cwd);
      }
    }
  }

  snapshot(): { files: FileChurn[]; added: number; removed: number } {
    const files = [...this.files.values()].map((f) => ({ ...f }));
    return { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) };
  }

  /** The footer chip, or undefined when nothing changed. */
  chip(): string | undefined {
    const s = this.snapshot();
    return s.files.length ? `Δ${s.files.length} +${s.added} −${s.removed}` : undefined;
  }
}

export function relativeTime(ts: number, now: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/** Keep the end of a long path, where the file name is. */
function fitPath(path: string, max: number): string {
  return path.length <= max ? path : `…${path.slice(-(max - 1))}`;
}

/** The `/changes` table as plain lines, the latest file first. */
export function changesTable(s: { files: FileChurn[]; added: number; removed: number }, width: number, now: number): string[] {
  if (!s.files.length) return ["No files changed on this branch yet."];
  const files = [...s.files].sort((a, b) => b.lastTouched - a.lastTouched || a.path.localeCompare(b.path));
  const addW = Math.max(2, ...files.map((f) => `+${f.added}`.length));
  const remW = Math.max(2, ...files.map((f) => `−${f.removed}`.length));
  const timeW = Math.max(0, ...files.map((f) => relativeTime(f.lastTouched, now).length));
  const pathW = Math.max(12, Math.min(80, width - addW - remW - timeW - 8));
  const n = files.length;
  return [
    `Changes on this branch: ${n} file${n === 1 ? "" : "s"}, +${s.added} −${s.removed}`,
    "",
    ...files.map((f) => `  ${`+${f.added}`.padStart(addW)} ${`−${f.removed}`.padStart(remW)}  ${fitPath(f.path, pathW).padEnd(pathW)}  ${relativeTime(f.lastTouched, now).padStart(timeW)}`.trimEnd()),
  ];
}

/** The table between borders; any key closes it. */
export class ChangesView extends Container {
  constructor(
    lines: string[],
    t: Styler,
    private readonly done: () => void,
  ) {
    super();
    this.addChild(new DynamicBorder());
    lines.forEach((line, i) => {
      if (!line) return this.addChild(new Spacer(1));
      const styled = i === 0 ? t.fg("accent", line) : line.replace(/^(\s*)(\+\d+)( +)(−\d+)/, (_m, sp: string, a: string, mid: string, r: string) => `${sp}${t.fg("success", a)}${mid}${t.fg("error", r)}`);
      this.addChild(new Text(styled, 1, 0));
    });
    this.addChild(new Spacer(1));
    this.addChild(new Text(t.fg("dim", "Press any key to close."), 1, 0));
    this.addChild(new DynamicBorder());
  }

  handleInput(_data: string): void {
    this.done();
  }
}
