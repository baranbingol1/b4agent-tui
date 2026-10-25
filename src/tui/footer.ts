/**
 * The 3-line footer (plan section 4):
 *   1. cwd (branch) • session name
 *   2. usage and context on the left; (provider) model • effort on the right,
 *      with `cold cache` after an effort change that costs the prompt cache
 *   3. chips: every `ctx.ui.setStatus` text, the permission mode first
 * Line 3 reads the footer data's extension statuses, so any extension's
 * status shows up without the footer knowing about it; known keys only get
 * an order and a colour.
 */
import { rainbow } from "./rainbow.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface Styler {
  fg(color: string, text: string): string;
}

export const STATUS = {
  permissions: "b4agent.permissions",
  spec: "b4agent.spec",
  jobs: "b4agent.jobs",
  review: "b4agent.review",
  recap: "b4agent.recap",
  schedule: "b4agent.schedule",
  changes: "b4agent.changes",
} as const;

/** Chips with a fixed place, in this order; every other status follows, sorted by key. */
const FIRST: readonly string[] = [STATUS.permissions, STATUS.spec, STATUS.review, STATUS.jobs, STATUS.schedule, STATUS.recap, STATUS.changes];

const ANSI = /\x1b\[[0-9;]*m/;

export function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function styleChip(key: string, text: string, t: Styler): string {
  // A status that brings its own colours is shown as it is.
  if (ANSI.test(text)) return text;
  if (key === STATUS.permissions) {
    if (/yolo/i.test(text)) return t.fg("error", text);
    if (/manual/i.test(text)) return t.fg("success", text);
    return t.fg("accent", text);
  }
  if (key === STATUS.changes) {
    return text.replace(/(\+\d+)|([-−]\d+)|([^+\-−]+)/g, (_m, add?: string, rem?: string, rest?: string) =>
      add ? t.fg("success", add) : rem ? t.fg("error", rem) : t.fg("muted", rest ?? ""),
    );
  }
  if (key === STATUS.review || key === STATUS.jobs) return t.fg("warning", text);
  return t.fg("muted", text);
}

/** Line 3's chips: the known ones in a fixed order, then the rest by key; empty texts are dropped. */
export function assembleChips(statuses: ReadonlyMap<string, string>, t: Styler): string[] {
  const rank = (k: string) => {
    const i = FIRST.indexOf(k);
    return i < 0 ? FIRST.length : i;
  };
  return [...statuses.entries()]
    .map(([k, v]) => [k, sanitizeStatus(v)] as const)
    .filter(([, v]) => v.length > 0)
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([k, v]) => styleChip(k, v, t));
}

export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

export function formatCwd(cwd: string, home = process.env.HOME || process.env.USERPROFILE): string {
  if (!home) return cwd;
  const rel = relative(resolve(home), resolve(cwd));
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Cache share of the latest request's prompt, in percent. */
  latestCacheHit?: number;
}

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

/** Usage over every entry, as Pi's footer counts it: replies, tool calls, compactions, summaries and usage entries. */
export function usageTotals(entries: readonly unknown[]): UsageTotals {
  const u: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const add = (x: Usage | undefined) => {
    if (!x) return;
    u.input += x.input;
    u.output += x.output;
    u.cacheRead += x.cacheRead;
    u.cacheWrite += x.cacheWrite;
    u.cost += x.cost?.total ?? 0;
  };
  for (const raw of entries) {
    const e = raw as { type?: string; usage?: Usage; message?: { role?: string; usage?: Usage } };
    if (e.type === "usage") add(e.usage);
    else if (e.type === "message" && e.message?.role === "assistant" && e.message.usage) {
      const m = e.message.usage;
      add(m);
      const prompt = m.input + m.cacheRead + m.cacheWrite;
      u.latestCacheHit = prompt > 0 ? (m.cacheRead / prompt) * 100 : undefined;
    } else if (e.type === "message" && e.message?.role === "toolResult") add(e.message.usage);
    else if (e.type === "branch_summary" || e.type === "compaction") add(e.usage);
  }
  return u;
}

export interface FooterData {
  cwd: string;
  branch: string | null;
  sessionName?: string;
  usage: UsageTotals;
  /** Context use in percent, or null when unknown (right after a compaction). */
  contextPercent: number | null;
  model?: { provider: string; id: string; reasoning: boolean };
  thinking: string;
  /** The effort is the model's top level: the effort word is drawn as a rainbow, like the prompt border. */
  topEffort?: boolean;
  subscription: boolean;
  providerCount: number;
  statuses: ReadonlyMap<string, string>;
  coldCache: boolean;
}

/** Left and right on one line. When they don't fit, the left side (usage) gives way first, down to 12 columns; then the right is cut. */
function spread(left: string, right: string, width: number): string {
  let lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (lw + 2 + rw > width && width - rw - 2 >= 12) {
    left = truncateToWidth(left, width - rw - 2, "…");
    lw = visibleWidth(left);
  }
  if (lw + 2 + rw <= width) return left + " ".repeat(width - lw - rw) + right;
  const room = width - lw - 2;
  if (room <= 0) return truncateToWidth(left, width, "…");
  const cut = truncateToWidth(right, room, "");
  return left + " ".repeat(width - lw - visibleWidth(cut)) + cut;
}

export function renderFooter(d: FooterData, width: number, t: Styler): string[] {
  let where = formatCwd(d.cwd);
  if (d.branch) where += ` (${d.branch})`;
  if (d.sessionName) where += ` • ${d.sessionName}`;

  const u = d.usage;
  const stats: string[] = [];
  if (u.input) stats.push(`${formatTokens(u.input)} in`);
  if (u.output) stats.push(`${formatTokens(u.output)} out`);
  if ((u.cacheRead || u.cacheWrite) && u.latestCacheHit !== undefined) stats.push(`${u.latestCacheHit.toFixed(0)}% cached`);
  if (u.cost || d.subscription) stats.push(`$${u.cost.toFixed(3)}${d.subscription ? " sub" : ""}`);
  const pct = d.contextPercent;
  const ctxText = pct === null ? "? context" : `${pct.toFixed(0)}% context`;
  const ctxColor = pct !== null && pct > 90 ? "error" : pct !== null && pct > 70 ? "warning" : "dim";
  // Each part is coloured on its own: a nested colour's reset would end an outer dim.
  const sepDim = t.fg("dim", " · ");
  let left = [...stats.map((s) => t.fg("dim", s)), t.fg(ctxColor, ctxText)].join(sepDim);
  if (visibleWidth(left) > width) left = truncateToWidth(left, width, "…");

  const m = d.model;
  const name = m?.id ?? "no model";
  const effort = m?.reasoning ? (d.thinking === "off" ? "thinking off" : d.thinking) : "";
  const effortText = effort ? t.fg("dim", " • ") + (d.topEffort && d.thinking !== "off" ? rainbow(effort) : t.fg("dim", effort)) : "";
  const hint = d.coldCache ? t.fg("dim", " · ") + t.fg("warning", "cold cache") : "";
  const withProvider = m && d.providerCount > 1 ? `(${m.provider}) ${name}` : name;
  const fits = (s: string) => visibleWidth(left) + 2 + visibleWidth(s) + visibleWidth(effortText) + visibleWidth(hint) <= width;
  const right = t.fg("dim", fits(withProvider) ? withProvider : name) + effortText + hint;

  const lines = [truncateToWidth(t.fg("dim", where), width, t.fg("dim", "…")), spread(left, right, width)];
  const chips = assembleChips(d.statuses, t);
  if (chips.length) lines.push(truncateToWidth(chips.join(t.fg("dim", " · ")), width, t.fg("dim", "…")));
  return lines;
}
