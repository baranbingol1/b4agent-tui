import type { ExtensionContext, ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Input, isKeyRelease, matchesKey, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AgentRecord, BashJob, Hub } from "./hub.js";
import { describe, groupMessages, summarizeSteps, type Msg } from "../tui/steps.js";

/**
 * The agent panel (plan section 2, Claude Code style): a few rows below
 * the editor for every subagent and background job that is working, needs
 * you, or just finished.
 *
 * ↓ on an empty prompt enters it; ↑/↓ move, ↑ past the top leaves, Enter
 * opens the live transcript, x stops (press twice) or dismisses a finished
 * row, Esc leaves. Typing anything else leaves the panel and goes to the
 * prompt. In the transcript, typing messages that agent, Ctrl+C interrupts
 * its current turn, PgUp/PgDn scroll, and Esc closes.
 */

const MAX_ROWS = 5;
/** Finished rows stay this long, so you see what just ended. */
const LINGER_MS = 60_000;
const KEY = "b4agent.agents";

type Row = { kind: "agent"; agent: AgentRecord } | { kind: "job"; job: BashJob };

const rowId = (r: Row) => (r.kind === "agent" ? r.agent.name : r.job.id);

export function elapsed(from: number, to = Date.now()): string {
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function tokens(n: number): string {
  return n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

const live = (a: AgentRecord) => a.status === "running" || a.status === "starting" || a.status === "waiting" || a.needsUser;

export class AgentPanel {
  private tui: TUI | undefined;
  private active = false;
  private selected = 0;
  private dismissed = new Set<string>();
  private confirmStop: { id: string; at: number } | undefined;
  private timer: NodeJS.Timeout | undefined;
  private offChange: (() => void) | undefined;
  private offInput: (() => void) | undefined;
  private overlayOpen = false;

  constructor(
    private readonly hub: Hub,
    private readonly ctx: () => ExtensionContext | undefined,
    private readonly onCtrlB: () => boolean,
  ) {}

  attach(ui: ExtensionUIContext) {
    ui.setWidget(
      KEY,
      (tui, theme) => {
        this.tui = tui;
        return { render: (w: number) => this.render(w, theme), invalidate: () => undefined };
      },
      { placement: "belowEditor" },
    );
    this.offInput = ui.onTerminalInput((data) => this.onInput(data));
    this.offChange = this.hub.onChange(() => this.refresh());
    this.refresh();
  }

  detach(ui?: ExtensionUIContext) {
    this.offChange?.();
    this.offInput?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    ui?.setWidget(KEY, undefined);
  }

  rows(): Row[] {
    const now = Date.now();
    const out: Row[] = [];
    for (const a of this.hub.agents.values()) {
      if (this.dismissed.has(a.name) && !live(a)) continue;
      if (live(a) || (!a.dormant && a.endedAt && now - a.endedAt < LINGER_MS)) out.push({ kind: "agent", agent: a });
    }
    for (const j of this.hub.jobs.values()) {
      if (this.dismissed.has(j.id) && j.status !== "running") continue;
      if (j.status === "running" || (j.endedAt && now - j.endedAt < LINGER_MS)) out.push({ kind: "job", job: j });
    }
    // Rows that need you first, then working ones.
    const rank = (r: Row) => (r.kind === "agent" ? (r.agent.needsUser || r.agent.status === "waiting" ? 0 : live(r.agent) ? 1 : 2) : r.job.status === "running" ? 1 : 2);
    return out.sort((a, b) => rank(a) - rank(b));
  }

  private refresh() {
    const any = this.rows().length > 0;
    if (any && !this.timer) {
      this.timer = setInterval(() => this.refresh(), 1000);
      this.timer.unref();
    } else if (!any && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.active = false;
    }
    this.tui?.requestRender();
  }

  private render(width: number, theme: Theme): string[] {
    const rows = this.rows();
    if (!rows.length) {
      this.active = false;
      return [];
    }
    this.selected = Math.min(this.selected, rows.length - 1);
    const start = Math.max(0, Math.min(this.selected - MAX_ROWS + 1, rows.length - MAX_ROWS));
    const shown = rows.slice(start, start + MAX_ROWS);
    const lines = shown.map((r, i) => {
      const sel = this.active && start + i === this.selected;
      const line = this.rowText(r, theme, sel);
      return truncateToWidth(sel ? theme.bold(line) : line, width);
    });
    const more = rows.length - shown.length;
    if (this.active) {
      const confirm = this.confirmStop && Date.now() - this.confirmStop.at < 2000 ? theme.fg("warning", `press x again to stop ${this.confirmStop.id} · `) : "";
      lines.push(truncateToWidth(theme.fg("dim", `  ${confirm}↑↓ move · enter open · x stop/dismiss · esc back${more ? ` · ${more} more` : ""}`), width));
    } else {
      const spend = this.hub.totals();
      const tail = spend.tokens ? ` · ${tokens(spend.tokens)} tok${spend.cost ? ` $${spend.cost.toFixed(2)}` : ""}` : "";
      lines.push(truncateToWidth(theme.fg("dim", `  ↓ agents${more ? ` (${more} more)` : ""}${tail}`), width));
    }
    return lines;
  }

  private rowText(r: Row, theme: Theme, sel: boolean): string {
    const pointer = sel ? theme.fg("accent", "› ") : "  ";
    if (r.kind === "job") {
      const j = r.job;
      const icon = j.status === "running" ? theme.fg("accent", "◷") : j.status === "done" ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const state = j.status === "running" ? "running" : j.status === "done" ? "done" : j.status === "killed" ? "stopped" : `exit ${j.exitCode}`;
      return `${pointer}${icon} ${j.id}  ${theme.fg("muted", j.command.split("\n")[0]!.slice(0, 50))}  ${theme.fg("dim", `${state} · ${elapsed(j.startedAt, j.endedAt)}`)}`;
    }
    const a = r.agent;
    const icon = a.needsUser
      ? theme.fg("warning", "!")
      : a.status === "waiting"
        ? theme.fg("warning", "?")
        : a.status === "running" || a.status === "starting"
          ? theme.fg("accent", "●")
          : a.status === "failed"
            ? theme.fg("error", "✗")
            : a.status === "stopped"
              ? theme.fg("muted", "■")
              : theme.fg("success", "✓");
    const state = a.needsUser
      ? theme.fg("warning", "needs you")
      : a.status === "waiting"
        ? theme.fg("warning", `asks ${a.parent}`)
        : a.status === "running" || a.status === "starting"
          ? theme.fg("muted", a.activity ?? "starting")
          : theme.fg("dim", a.status === "idle" ? "done" : a.status);
    const model = a.model.replace(/^[^/]+\//, "");
    const meta = theme.fg("dim", `${model} · ${elapsed(a.startedAt, live(a) ? undefined : a.endedAt)}${a.tokens ? ` · ${tokens(a.tokens)}` : ""}`);
    const nest = a.depth > 1 ? theme.fg("dim", "↳ ".repeat(a.depth - 1)) : "";
    return `${pointer}${nest}${icon} ${theme.bold(a.name)}  ${state}  ${meta}`;
  }

  private editorFocusedAndEmpty(): boolean {
    const focused = (this.tui as unknown as { getFocusedComponent?: () => unknown } | undefined)?.getFocusedComponent?.() as { getText?: () => string } | null | undefined;
    if (!focused || typeof focused.getText !== "function") return false;
    return focused.getText() === "";
  }

  private onInput(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data) || this.overlayOpen) return undefined;
    if (matchesKey(data, "ctrl+b") && this.onCtrlB()) return { consume: true };
    const rows = this.rows();
    if (!this.active) {
      if (rows.length && matchesKey(data, "down") && this.editorFocusedAndEmpty()) {
        this.active = true;
        this.selected = 0;
        this.tui?.requestRender();
        return { consume: true };
      }
      return undefined;
    }
    if (!rows.length) {
      this.active = false;
      return undefined;
    }
    const leave = () => {
      this.active = false;
      this.confirmStop = undefined;
      this.tui?.requestRender();
    };
    if (matchesKey(data, "escape")) {
      leave();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selected === 0) leave();
      else this.selected--;
      this.tui?.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "down")) {
      this.selected = Math.min(rows.length - 1, this.selected + 1);
      this.tui?.requestRender();
      return { consume: true };
    }
    const row = rows[this.selected];
    if (!row) return { consume: true };
    if (matchesKey(data, "enter")) {
      if (row.kind === "agent") void this.open(row.agent.name);
      else this.ctx()?.ui.notify(`${row.job.id}: ${row.job.command.split("\n")[0]}\nLog: ${row.job.log}`, "info");
      return { consume: true };
    }
    if (data === "x" || data === "X") {
      const id = rowId(row);
      const running = row.kind === "agent" ? live(row.agent) : row.job.status === "running";
      if (!running) {
        this.dismissed.add(id);
      } else if (this.confirmStop?.id === id && Date.now() - this.confirmStop.at < 2000) {
        this.confirmStop = undefined;
        if (row.kind === "agent") void this.hub.stop(id);
        else row.job.kill();
      } else {
        this.confirmStop = { id, at: Date.now() };
      }
      this.tui?.requestRender();
      return { consume: true };
    }
    // Anything else goes back to the prompt.
    leave();
    return undefined;
  }

  /** The live transcript of one agent; typing messages it. */
  async open(name: string) {
    const ctx = this.ctx();
    const rec = this.hub.agents.get(name);
    if (!ctx || !rec) return;
    this.overlayOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _kb, done) => new Transcript(this.hub, name, tui, theme, done),
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "85%", anchor: "center" } },
      );
    } finally {
      this.overlayOpen = false;
      this.active = false;
      this.tui?.requestRender();
    }
  }
}

class Transcript implements Component {
  private readonly input = new Input({ prompt: "› " });
  private scroll = 0;
  private readonly off: () => void;
  private note: string | undefined;
  /** Every step, as before the compact view; ctrl+o toggles. */
  private expanded = false;
  focused = true;

  constructor(
    private readonly hub: Hub,
    private readonly name: string,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly done: (r: void) => void,
  ) {
    this.input.focused = true;
    this.off = hub.onChange(() => tui.requestRender());
    this.input.onSubmit = (v) => {
      const text = v.trim();
      if (!text) return;
      this.input.setValue("");
      this.scroll = 0;
      this.note = undefined;
      void hub.userMessage(this.name, text).catch((e: unknown) => {
        this.note = `couldn't send: ${(e as Error).message}`;
        this.tui.requestRender();
      });
    };
  }

  dispose() {
    this.off();
  }

  invalidate() {}

  handleInput(data: string) {
    const rec = this.hub.agents.get(this.name);
    if (matchesKey(data, "escape")) {
      this.off();
      this.done();
      return;
    }
    if (matchesKey(data, "ctrl+c")) {
      if (rec?.session?.isStreaming) {
        void rec.session.abort();
        this.note = "interrupted its current turn; type to give it new instructions";
      }
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "pageUp")) this.scroll += 10;
    else if (matchesKey(data, "pageDown")) this.scroll = Math.max(0, this.scroll - 10);
    else if (matchesKey(data, "ctrl+o")) this.expanded = !this.expanded;
    else this.input.handleInput(data);
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const t = this.theme;
    const rec = this.hub.agents.get(this.name);
    const inner = Math.max(20, width - 4);
    const height = Math.max(8, Math.floor(this.tui.terminal.rows * 0.85) - 2);
    const border = (s: string) => t.fg("borderAccent", s);
    const pad = (s: string) => {
      const cut = truncateToWidth(s, inner);
      return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
    };
    if (!rec) return [border(`╭${"─".repeat(inner + 2)}╮`), pad(`${this.name} is gone. Esc closes.`), border(`╰${"─".repeat(inner + 2)}╯`)];

    const status = rec.needsUser ? "needs you" : rec.status === "running" ? (rec.activity ?? "running") : rec.status === "idle" ? "done" : rec.status;
    const title = ` ${rec.name} · ${rec.type} · ${rec.model} · ${status} · ${elapsed(rec.startedAt, rec.status === "running" ? undefined : rec.endedAt)} `;
    const top = border("╭─") + t.bold(truncateToWidth(title, inner - 2)) + border("─".repeat(Math.max(0, inner - visibleWidth(truncateToWidth(title, inner - 2)))) + "╮");

    const body: string[] = [];
    for (const l of transcriptLines(rec, t, this.expanded)) body.push(...(l ? wrapTextWithAnsi(l, inner) : [""]));
    const room = height - 4;
    const maxScroll = Math.max(0, body.length - room);
    this.scroll = Math.min(this.scroll, maxScroll);
    const end = body.length - this.scroll;
    const view = body.slice(Math.max(0, end - room), end);
    while (view.length < room) view.unshift("");

    const hint = this.note ?? `Message @${rec.name} · enter send · ctrl+c interrupt · ctrl+o ${this.expanded ? "collapse" : "all"} steps · pgup/pgdn scroll${this.scroll ? ` (${this.scroll} up)` : ""} · esc close`;
    const inputLine = this.input.render(inner)[0] ?? "";
    return [top, ...view.map(pad), pad(t.fg("dim", "─".repeat(inner))), pad(inputLine), pad(t.fg("dim", hint)), border(`╰${"─".repeat(inner + 2)}╯`)];
  }
}

type Block = { type: string; text?: string; thinking?: string; name?: string; arguments?: Record<string, unknown> };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((b) => (b.type === "text" ? (b.text ?? "") : b.type === "image" ? "[image]" : "")).join("\n");
}

function argSummary(args: Record<string, unknown> | undefined): string {
  const a = args ?? {};
  for (const k of ["command", "path", "pattern", "prompt", "text", "to", "action"]) if (typeof a[k] === "string") return String(a[k]).split("\n")[0]!.slice(0, 160);
  return JSON.stringify(a).slice(0, 160);
}

function transcriptLines(rec: AgentRecord, t: Theme, expanded: boolean): string[] {
  const out: string[] = [];
  const messages = rec.session?.messages ?? [];
  if (!messages.length) out.push(t.fg("dim", rec.dormant ? "From an earlier run; type to continue its conversation." : "Starting…"));
  if (!expanded) {
    // The same compact view as the main transcript: one line per run of steps, errors and running calls under it.
    for (const b of groupMessages(messages as Msg[])) {
      if (b.kind === "message") out.push(...messageLines(b.message as never, t));
      else {
        const s = summarizeSteps(b.steps);
        const busy = s.running > 0;
        out.push("", t.fg(busy ? "accent" : "muted", busy ? `Working · ${s.text.charAt(0).toLowerCase()}${s.text.slice(1)}` : s.text) + (s.failed ? t.fg("error", ` · ${s.failed} failed`) : "") + t.fg("dim", " ›"));
        for (const step of b.steps) {
          if (!step.result) out.push(t.fg("toolTitle", `  → ${describe(step)}`) + t.fg("muted", " …"));
          else if (step.result.isError) out.push(t.fg("toolTitle", `  → ${describe(step)}`), t.fg("error", `    ✗ ${textOf(step.result.content).trim().split("\n")[0]?.slice(0, 200) ?? ""}`));
        }
      }
    }
  } else for (const m of messages as never[]) out.push(...messageLines(m, t));
  if (rec.status === "running" && rec.activity) out.push("", t.fg("muted", `… ${rec.activity}`));
  for (const q of rec.session?.getSteeringMessages() ?? []) out.push(t.fg("userMessageText", `› ${q}`) + t.fg("dim", "  (queued: it sees this after its current step)"));
  if (rec.status === "failed" && rec.error) out.push("", t.fg("error", rec.error));
  return out;
}

function messageLines(m: { role: string; content?: unknown; customType?: string; toolName?: string; isError?: boolean }, t: Theme): string[] {
  const out: string[] = [];
  if (m.role === "user") {
    out.push("", t.fg("userMessageText", `› ${textOf(m.content)}`));
  } else if (m.role === "assistant") {
    for (const b of (m.content ?? []) as Block[]) {
      if (b.type === "text" && b.text?.trim()) out.push("", b.text.trim());
      else if (b.type === "toolCall") out.push(t.fg("toolTitle", `→ ${b.name} ${argSummary(b.arguments)}`));
    }
  } else if (m.role === "toolResult") {
    const first = textOf(m.content).trim().split("\n")[0]?.slice(0, 200) ?? "";
    out.push(t.fg(m.isError ? "error" : "dim", `  ${m.isError ? "✗" : "←"} ${first}`));
  } else if (m.role === "custom") {
    out.push("", t.fg("customMessageText", textOf(m.content)));
  }
  return out;
}
