/**
 * /usage (plan sections 14 and 16): the ChatGPT plan's limits for the
 * `openai-codex` login (each window's used percent and reset time, credits),
 * plus this session's token and cost totals from its entries.
 *
 * Sources, as in Codex CLI (openai/codex, Apache-2.0, read 2026-10-21):
 * - `GET {chatgpt base}/wham/usage` (`codex-rs/backend-client/src/client.rs`,
 *   `get_rate_limits`): `rate_limit.primary_window` / `secondary_window` with
 *   `used_percent`, `limit_window_seconds`, `reset_at` (unix seconds), plus
 *   `plan_type`, `credits`, `additional_rate_limits`. Asked fresh on every /usage.
 * - the `x-codex-primary-used-percent`, `-window-minutes`, `-reset-at` (and
 *   `secondary`) headers on every Codex response, and `x-<limit>-...` for other
 *   metered limits (`codex-rs/codex-api/src/rate_limits.rs`); and over
 *   WebSocket, the `codex.rate_limits` event. Pi 1.3 doesn't parse either; we keep
 *   the last one from `after_provider_response` / `provider_stream_event` as the
 *   fallback when the live call fails.
 * Which window is "5-hour" or "weekly" comes from its length, not its slot: a
 * Pro account measured 2026-10-21 had only a weekly window, in the primary slot.
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { chatgptAccountId } from "../painter/request.js";

export interface LimitWindow {
  usedPercent: number;
  windowMinutes?: number;
  /** Unix seconds. */
  resetsAt?: number;
}

export interface LimitSnapshot {
  limitId: string;
  limitName?: string;
  primary?: LimitWindow;
  secondary?: LimitWindow;
  credits?: { hasCredits: boolean; unlimited: boolean; balance?: string };
  planType?: string;
  limitReached?: boolean;
}

// ---------------------------------------------------------------- headers

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function bool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (/^(true|1)$/i.test(v.trim())) return true;
  if (/^(false|0)$/i.test(v.trim())) return false;
  return undefined;
}

function headerWindow(h: Record<string, string>, prefix: string, slot: "primary" | "secondary"): LimitWindow | undefined {
  const used = num(h[`${prefix}-${slot}-used-percent`]);
  if (used === undefined) return undefined;
  const minutes = num(h[`${prefix}-${slot}-window-minutes`]);
  const reset = num(h[`${prefix}-${slot}-reset-at`]);
  // Codex's rule: a window that is all zeros and has no reset time is absent.
  if (used === 0 && !minutes && reset === undefined) return undefined;
  return { usedPercent: used, ...(minutes ? { windowMinutes: minutes } : {}), ...(reset !== undefined ? { resetsAt: reset } : {}) };
}

/** Every rate-limit family in a Codex response's headers; `codex` first. Empty when there are none. */
export function parseRateLimitHeaders(headers: Record<string, string>): LimitSnapshot[] {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const ids = new Set<string>();
  for (const k of Object.keys(h)) {
    const m = /^x-(.+)-primary-used-percent$/.exec(k);
    if (m) ids.add(m[1]!);
  }
  const out: LimitSnapshot[] = [];
  for (const id of [...ids].sort((a, b) => (a === "codex" ? -1 : b === "codex" ? 1 : a.localeCompare(b)))) {
    const prefix = `x-${id}`;
    const primary = headerWindow(h, prefix, "primary");
    const secondary = headerWindow(h, prefix, "secondary");
    const s: LimitSnapshot = { limitId: id.replace(/-/g, "_"), ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) };
    const name = h[`${prefix}-limit-name`]?.trim();
    if (name) s.limitName = name;
    if (id === "codex") {
      const has = bool(h["x-codex-credits-has-credits"]);
      const unl = bool(h["x-codex-credits-unlimited"]);
      const bal = h["x-codex-credits-balance"]?.trim();
      if (has !== undefined && unl !== undefined) s.credits = { hasCredits: has, unlimited: unl, ...(bal ? { balance: bal } : {}) };
      const plan = h["x-codex-plan-type"]?.trim();
      if (plan) s.planType = plan;
    }
    if (s.primary || s.secondary || s.credits || id === "codex") out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------- wham/usage JSON

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function jsonWindow(v: unknown): LimitWindow | undefined {
  const w = obj(v);
  if (!w || typeof w.used_percent !== "number") return undefined;
  const secs = typeof w.limit_window_seconds === "number" && w.limit_window_seconds > 0 ? w.limit_window_seconds : undefined;
  return {
    usedPercent: w.used_percent,
    ...(secs ? { windowMinutes: Math.ceil(secs / 60) } : {}),
    ...(typeof w.reset_at === "number" ? { resetsAt: w.reset_at } : {}),
  };
}

function jsonLimit(id: string, rl: unknown, extra: Partial<LimitSnapshot> = {}): LimitSnapshot {
  const r = obj(rl);
  const primary = jsonWindow(r?.primary_window);
  const secondary = jsonWindow(r?.secondary_window);
  return {
    limitId: id,
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(typeof r?.limit_reached === "boolean" ? { limitReached: r.limit_reached } : {}),
    ...extra,
  };
}

/** The `wham/usage` body as snapshots: `codex` first, then `additional_rate_limits`. */
export function parseUsagePayload(body: unknown): LimitSnapshot[] {
  const b = obj(body);
  if (!b) throw new Error("usage response is not an object");
  const plan = typeof b.plan_type === "string" ? b.plan_type : undefined;
  const c = obj(b.credits);
  const credits =
    c && typeof c.has_credits === "boolean"
      ? { hasCredits: c.has_credits, unlimited: c.unlimited === true, ...(typeof c.balance === "string" ? { balance: c.balance } : {}) }
      : undefined;
  const out = [jsonLimit("codex", b.rate_limit, { ...(plan ? { planType: plan } : {}), ...(credits ? { credits } : {}) })];
  if (Array.isArray(b.additional_rate_limits)) {
    for (const a of b.additional_rate_limits) {
      const d = obj(a);
      if (!d) continue;
      const id = typeof d.metered_feature === "string" ? d.metered_feature : typeof d.limit_name === "string" ? d.limit_name : "other";
      out.push(jsonLimit(id, d.rate_limit, typeof d.limit_name === "string" ? { limitName: d.limit_name } : {}));
    }
  }
  return out;
}

/** A `codex.rate_limits` stream event (the WebSocket transport's form of the headers). */
export function parseRateLimitEvent(data: unknown): LimitSnapshot | undefined {
  const e = obj(data);
  if (!e || e.type !== "codex.rate_limits") return undefined;
  const rl = obj(e.rate_limits);
  const win = (v: unknown): LimitWindow | undefined => {
    const w = obj(v);
    if (!w || typeof w.used_percent !== "number") return undefined;
    return { usedPercent: w.used_percent, ...(typeof w.window_minutes === "number" ? { windowMinutes: w.window_minutes } : {}), ...(typeof w.reset_at === "number" ? { resetsAt: w.reset_at } : {}) };
  };
  const primary = win(rl?.primary);
  const secondary = win(rl?.secondary);
  const c = obj(e.credits);
  const id = typeof e.metered_limit_name === "string" ? e.metered_limit_name : typeof e.limit_name === "string" ? e.limit_name : "codex";
  return {
    limitId: id.toLowerCase().replace(/-/g, "_"),
    ...(primary ? { primary } : {}),
    ...(secondary ? { secondary } : {}),
    ...(typeof e.plan_type === "string" ? { planType: e.plan_type } : {}),
    ...(c && typeof c.has_credits === "boolean" ? { credits: { hasCredits: c.has_credits, unlimited: c.unlimited === true, ...(typeof c.balance === "string" ? { balance: c.balance } : {}) } } : {}),
  };
}

// ---------------------------------------------------------------- cache from responses

let last: { at: number; limits: LimitSnapshot[] } | undefined;

/** Keeps the rate limits from a Codex response's headers (a no-op for other responses). */
export function recordRateLimitHeaders(headers: Record<string, string>, at = Date.now()) {
  const limits = parseRateLimitHeaders(headers).filter((s) => s.primary || s.secondary || s.credits);
  if (limits.length) last = { at, limits };
}

export function lastRecorded() {
  return last;
}

export function resetRecorded() {
  last = undefined;
}

// ---------------------------------------------------------------- session totals

export interface SessionTotals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  byModel: Map<string, { turns: number; tokens: number; cost: number }>;
}

/** Sums the usage of every assistant message in the session file, abandoned branches included (they were paid for too). */
export function sessionTotals(entries: readonly unknown[]): SessionTotals {
  const t: SessionTotals = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, byModel: new Map() };
  for (const e of entries) {
    const entry = obj(e);
    const m = obj(entry?.message);
    if (entry?.type !== "message" || m?.role !== "assistant") continue;
    const u = obj(m.usage);
    if (!u) continue;
    const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
    const cost = typeof obj(u.cost)?.total === "number" ? (obj(u.cost)!.total as number) : 0;
    t.turns++;
    t.input += n("input");
    t.output += n("output");
    t.cacheRead += n("cacheRead");
    t.cacheWrite += n("cacheWrite");
    t.cost += cost;
    const key = `${typeof m.provider === "string" ? m.provider : "?"}/${typeof m.model === "string" ? m.model : "?"}`;
    const row = t.byModel.get(key) ?? { turns: 0, tokens: 0, cost: 0 };
    row.turns++;
    row.tokens += n("input") + n("output") + n("cacheRead") + n("cacheWrite");
    row.cost += cost;
    t.byModel.set(key, row);
  }
  return t;
}

// ---------------------------------------------------------------- formatting

/** `5-hour`, `weekly`, `daily`, `90-minute`... from the window length. */
export function windowLabel(minutes: number | undefined): string {
  if (!minutes) return "limit";
  if (minutes === 10080) return "weekly";
  if (minutes === 1440) return "daily";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function relative(seconds: number): string {
  if (seconds <= 0) return "now";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

export function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

export interface UsageView {
  limits?: LimitSnapshot[];
  /** Where the limits came from, e.g. "live from chatgpt.com". */
  source?: string;
  /** Why there are no limits. */
  note?: string;
  totals: SessionTotals;
}

type Paint = { bar(p: number, w: number): string; dim(s: string): string; bold(s: string): string; warn(s: string): string };
const plain: Paint = { bar: (p, w) => "█".repeat(Math.round((p / 100) * w)) + "░".repeat(w - Math.round((p / 100) * w)), dim: (s) => s, bold: (s) => s, warn: (s) => s };

/** The overlay's (and print mode's) lines. */
export function usageLines(v: UsageView, now = Date.now(), p: Paint = plain): string[] {
  const out: string[] = [];
  const codex = v.limits?.find((l) => l.limitId === "codex");
  out.push(p.bold(`ChatGPT plan limits${codex?.planType ? ` (${codex.planType})` : ""}`));
  if (!v.limits) out.push(`  ${v.note ?? "unavailable"}`);
  for (const l of v.limits ?? []) {
    const name = l.limitId === "codex" ? "" : `${l.limitName ?? l.limitId} `;
    const ws = [l.primary, l.secondary].filter((w): w is LimitWindow => Boolean(w)).sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
    if (!ws.length && l.limitId === "codex") out.push("  no usage windows reported");
    for (const w of ws) {
      const pct = Math.max(0, Math.min(100, w.usedPercent));
      const label = `${name}${windowLabel(w.windowMinutes)}`.padEnd(name ? 24 : 10);
      const reset = w.resetsAt
        ? `resets ${new Date(w.resetsAt * 1000).toLocaleString("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} (in ${relative(w.resetsAt - now / 1000)})`
        : "";
      const used = `${String(Math.round(w.usedPercent)).padStart(3)}% used`;
      out.push(`  ${label} ${p.bar(pct, 20)} ${pct >= 90 ? p.warn(used) : used}  ${p.dim(reset)}`);
    }
    if (l.limitReached) out.push(`  ${p.warn("limit reached")}`);
  }
  const cr = codex?.credits;
  if (cr) out.push(`  credits    ${cr.unlimited ? "unlimited" : cr.hasCredits ? (cr.balance ? Number(cr.balance).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "yes") : "none"}`);
  if (v.source) out.push(p.dim(`  ${v.source}`));
  out.push("");
  const t = v.totals;
  out.push(p.bold("This session"));
  if (!t.turns) out.push("  no model turns yet");
  else {
    out.push(`  ${t.turns} turn${t.turns === 1 ? "" : "s"} · input ${tokens(t.input)} · output ${tokens(t.output)} · cache read ${tokens(t.cacheRead)}${t.cacheWrite ? ` · cache write ${tokens(t.cacheWrite)}` : ""}`);
    out.push(`  cost $${t.cost.toFixed(2)} ${p.dim("(at API prices; a ChatGPT plan bills by the limits above)")}`);
    if (t.byModel.size > 1) for (const [k, r] of t.byModel) out.push(p.dim(`    ${k}: ${r.turns} turns, ${tokens(r.tokens)} tokens, $${r.cost.toFixed(2)}`));
  }
  return out;
}

// ---------------------------------------------------------------- fetching

/** The parts of Pi's ModelRegistry /usage needs. */
interface UsageRegistry {
  getProviderAuthStatus(provider: string): { configured: boolean };
  getProviderAuth(provider: string): Promise<{ auth: { apiKey?: string; baseUrl?: string } } | undefined>;
  getAll(): { provider: string; baseUrl?: string }[];
  getProvider(provider: string): { baseUrl?: string } | undefined;
}

export async function fetchLimits(reg: UsageRegistry, signal?: AbortSignal, doFetch: typeof fetch = fetch): Promise<{ limits: LimitSnapshot[]; url: string }> {
  const auth = await reg.getProviderAuth("openai-codex");
  const token = auth?.auth.apiKey;
  if (!token) throw new Error("the openai-codex login is missing or expired; run /login");
  const account = chatgptAccountId(token);
  if (!account) throw new Error("the openai-codex token has no ChatGPT account id; run /login again");
  const base = (auth.auth.baseUrl ?? reg.getAll().find((m) => m.provider === "openai-codex")?.baseUrl ?? reg.getProvider("openai-codex")?.baseUrl ?? "https://chatgpt.com/backend-api").replace(/\/+$/, "");
  const timeout = AbortSignal.timeout(15_000);
  const url = `${base}/wham/usage`;
  const res = await doFetch(url, {
    headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": account, originator: "pi", "User-Agent": "codex-cli", accept: "application/json" },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return { limits: parseUsagePayload(await res.json()), url };
}

async function gather(ctx: ExtensionContext): Promise<UsageView> {
  const totals = sessionTotals(ctx.sessionManager.getEntries());
  const reg = ctx.modelRegistry as unknown as UsageRegistry;
  if (!reg.getProviderAuthStatus("openai-codex").configured) return { totals, note: "no openai-codex login (ChatGPT plan); /login shows the options" };
  try {
    const live = await fetchLimits(reg);
    return { totals, limits: live.limits, source: `live from ${live.url.replace(/^https?:\/\//, "")}` };
  } catch (e) {
    const rec = lastRecorded();
    if (rec) return { totals, limits: rec.limits, source: `from the last response, ${relative((Date.now() - rec.at) / 1000)} ago (live check failed: ${(e as Error).message})` };
    return { totals, note: `couldn't read them: ${(e as Error).message}` };
  }
}

class UsageOverlay implements Component {
  constructor(
    private readonly view: UsageView,
    private readonly theme: Theme,
    private readonly close: () => void,
  ) {}

  invalidate() {}

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "enter") || matchesKey(data, "ctrl+c") || data === "q") this.close();
  }

  render(width: number): string[] {
    const t = this.theme;
    const inner = Math.max(20, width - 4);
    const border = (s: string) => t.fg("borderAccent", s);
    const pad = (s: string) => {
      const cut = truncateToWidth(s, inner);
      return `${border("│")} ${cut}${" ".repeat(Math.max(0, inner - visibleWidth(cut)))} ${border("│")}`;
    };
    const paint: Paint = {
      bar: (p, w) => {
        const f = Math.round((p / 100) * w);
        return t.fg(p >= 90 ? "error" : p >= 70 ? "warning" : "success", "█".repeat(f)) + t.fg("dim", "░".repeat(w - f));
      },
      dim: (s) => t.fg("dim", s),
      bold: (s) => t.bold(s),
      warn: (s) => t.fg("warning", s),
    };
    const title = " usage ";
    const top = border("╭─") + t.bold(title) + border("─".repeat(Math.max(0, inner - visibleWidth(title))) + "╮");
    return [top, ...usageLines(this.view, Date.now(), paint).map(pad), pad(t.fg("dim", "esc close")), border(`╰${"─".repeat(inner + 2)}╯`)];
  }
}

export default function usage(pi: ExtensionAPI) {
  pi.on("after_provider_response", (e) => recordRateLimitHeaders(e.headers));
  pi.on("provider_stream_event", (e) => {
    const s = parseRateLimitEvent(e.data);
    if (s && (s.primary || s.secondary)) {
      const rest = lastRecorded()?.limits.filter((l) => l.limitId !== s.limitId) ?? [];
      // Keep credits and plan from the headers when the event lacks them.
      const prev = lastRecorded()?.limits.find((l) => l.limitId === s.limitId);
      const merged = { ...(prev?.credits ? { credits: prev.credits } : {}), ...(prev?.planType ? { planType: prev.planType } : {}), ...s };
      const limits = merged.limitId === "codex" ? [merged, ...rest] : [...rest, merged];
      recordSnapshots(limits);
    }
  });
  pi.registerCommand("usage", {
    description: "ChatGPT plan limits (usage windows, reset times, credits) and this session's tokens and cost",
    handler: async (_args, ctx) => {
      const view = await gather(ctx);
      if (!ctx.hasUI || ctx.mode !== "tui") {
        // Print mode has no UI (notify is a no-op there), so the text goes to stdout.
        if (ctx.mode === "print") process.stdout.write(`${usageLines(view).join("\n")}\n`);
        else ctx.ui.notify(usageLines(view).join("\n"), "info");
        return;
      }
      await ctx.ui.custom<void>((_tui: TUI, theme, _kb, done) => new UsageOverlay(view, theme, () => done()), {
        overlay: true,
        overlayOptions: { width: "80%", maxHeight: "80%", anchor: "center" },
      });
    },
  });
}

function recordSnapshots(limits: LimitSnapshot[]) {
  last = { at: Date.now(), limits };
}
