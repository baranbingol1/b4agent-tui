/**
 * The footer's `cold cache` hint (plan sections 5 and 13). Measured live on
 * the ChatGPT login: changing the reasoning effort mid-conversation gave
 * cacheRead 0 on the next request, and going back to the earlier effort read
 * from the cache again. So the OpenAI prompt cache is keyed per effort, and
 * the next turn after a change to an effort with no recent request is cold.
 */

/** Providers whose prompt cache is keyed per reasoning effort (measured on openai-codex; same Responses backend). */
export const PER_EFFORT_CACHE_PROVIDERS: ReadonlySet<string> = new Set(["openai", "openai-codex"]);

/**
 * How long an effort's cache is assumed to stay warm. OpenAI keeps prompt
 * caches for 5-10 minutes of inactivity (up to an hour off-peak); the short
 * end errs towards showing the hint.
 */
export const WARM_MS = 5 * 60_000;

/** The last request sent at each effort, per model (`provider/id`). */
export type SentLog = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface ColdCacheQuery {
  provider: string;
  modelId: string;
  /** The effort the next request will use. */
  level: string;
  now: number;
  sent: SentLog;
}

/**
 * Whether the next request will miss the cache because of the effort: only
 * on a per-effort provider, only mid-conversation (a request already went to
 * this model), and not when this effort was used recently.
 */
export function isColdAfterEffortChange(q: ColdCacheQuery): boolean {
  if (!PER_EFFORT_CACHE_PROVIDERS.has(q.provider)) return false;
  const byLevel = q.sent.get(`${q.provider}/${q.modelId}`);
  if (!byLevel || byLevel.size === 0) return false;
  const at = byLevel.get(q.level);
  return at === undefined || q.now - at > WARM_MS;
}

/** The slice of a session entry `sentFromEntries` reads. */
export interface HistoryEntry {
  type: string;
  timestamp?: string;
  thinkingLevel?: string;
  message?: { role?: string; provider?: string; model?: string; timestamp?: number };
}

/**
 * The sent log of a saved branch: each assistant reply counts as a request at
 * the effort set by the latest `thinking_level_change` before it. Replies
 * before any effort entry are skipped (their effort is unknown).
 */
export function sentFromEntries(entries: readonly HistoryEntry[]): SentLog {
  const sent = new Map<string, Map<string, number>>();
  let level: string | undefined;
  for (const e of entries) {
    if (e.type === "thinking_level_change" && e.thinkingLevel) level = e.thinkingLevel;
    const m = e.message;
    if (e.type !== "message" || m?.role !== "assistant" || !m.provider || !m.model || !level) continue;
    const at = m.timestamp ?? (e.timestamp ? Date.parse(e.timestamp) : NaN);
    if (!Number.isFinite(at)) continue;
    const key = `${m.provider}/${m.model}`;
    let byLevel = sent.get(key);
    if (!byLevel) sent.set(key, (byLevel = new Map()));
    byLevel.set(level, Math.max(byLevel.get(level) ?? 0, at));
  }
  return sent;
}

/**
 * Tracks requests and effort changes: `hint()` is true from an effort change
 * that makes the cache cold until the next request has been answered.
 */
export class ColdCacheTracker {
  private readonly sent = new Map<string, Map<string, number>>();
  /** Bumped by every effort change that makes the cache cold; 0 = warm. */
  private coldChange = 0;
  private changes = 0;
  /** The cold change the request in flight was sent under. */
  private sentUnder = 0;

  /** A request is about to go out with this model and effort (Pi's `turn_start`). */
  requestSent(provider: string, modelId: string, level: string, now: number): void {
    const key = `${provider}/${modelId}`;
    let m = this.sent.get(key);
    if (!m) this.sent.set(key, (m = new Map()));
    m.set(level, now);
    this.sentUnder = this.coldChange;
  }

  /** An assistant reply arrived: the request that paid for the cold cache is done, unless the effort changed again since it went out. */
  replied(): void {
    if (this.coldChange && this.sentUnder === this.coldChange) this.coldChange = 0;
    this.sentUnder = 0;
  }

  /** The effort changed (Tab, `/thinking`). Recomputed on every change, so cycling back to a warm effort clears it. */
  effortChanged(provider: string | undefined, modelId: string | undefined, level: string, now: number): void {
    const cold = provider !== undefined && modelId !== undefined && isColdAfterEffortChange({ provider, modelId, level, now, sent: this.sent });
    this.coldChange = cold ? ++this.changes : 0;
  }

  /** Another model: the hint is about effort only, and a new model's first request is cold for its own reasons. */
  modelChanged(): void {
    this.coldChange = 0;
  }

  /** Start over from a session's history (`sentFromEntries`), on session start, resume and tree moves. */
  reset(sent: SentLog = new Map()): void {
    this.sent.clear();
    for (const [k, v] of sent) this.sent.set(k, new Map(v));
    this.coldChange = 0;
    this.sentUnder = 0;
  }

  hint(): boolean {
    return this.coldChange !== 0;
  }
}
