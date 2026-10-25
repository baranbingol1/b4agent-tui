import { describe, expect, it } from "vitest";
import { ColdCacheTracker, isColdAfterEffortChange, sentFromEntries, WARM_MS } from "../../src/tui/cold-cache.js";

const T0 = 1_000_000;
const log = (entries: [string, string, number][]) => {
  const m = new Map<string, Map<string, number>>();
  for (const [model, level, at] of entries) {
    if (!m.has(model)) m.set(model, new Map());
    m.get(model)!.set(level, at);
  }
  return m;
};

describe("isColdAfterEffortChange", () => {
  const q = { provider: "openai-codex", modelId: "gpt-6.1-sol", now: T0 + 60_000 };
  const sent = log([["openai-codex/gpt-6.1-sol", "high", T0]]);

  it("is cold for an effort never sent in this conversation", () => {
    expect(isColdAfterEffortChange({ ...q, level: "xhigh", sent })).toBe(true);
  });
  it("is warm going back to an effort sent recently (measured: high -> xhigh -> high read the cache)", () => {
    expect(isColdAfterEffortChange({ ...q, level: "high", sent })).toBe(false);
  });
  it("is cold going back to an effort last sent longer ago than the cache lasts", () => {
    expect(isColdAfterEffortChange({ ...q, level: "high", now: T0 + WARM_MS + 1, sent })).toBe(true);
  });
  it("is never shown before the first request (nothing cached to lose)", () => {
    expect(isColdAfterEffortChange({ ...q, level: "xhigh", sent: new Map() })).toBe(false);
  });
  it("only applies to OpenAI providers", () => {
    expect(isColdAfterEffortChange({ ...q, provider: "anthropic", level: "xhigh", sent: log([["anthropic/gpt-6.1-sol", "high", T0]]) })).toBe(false);
    expect(isColdAfterEffortChange({ ...q, provider: "openai", level: "xhigh", sent: log([["openai/gpt-6.1-sol", "high", T0]]) })).toBe(true);
  });
  it("is per model: requests to another model don't count", () => {
    expect(isColdAfterEffortChange({ ...q, level: "high", sent: log([["openai-codex/gpt-6-luna", "high", T0]]) })).toBe(false);
  });
});

describe("ColdCacheTracker", () => {
  it("shows the hint from the change until the next reply", () => {
    const c = new ColdCacheTracker();
    c.requestSent("openai-codex", "m", "high", T0);
    c.replied();
    c.effortChanged("openai-codex", "m", "xhigh", T0 + 1000);
    expect(c.hint()).toBe(true);
    c.requestSent("openai-codex", "m", "xhigh", T0 + 2000);
    expect(c.hint()).toBe(true);
    c.replied();
    expect(c.hint()).toBe(false);
  });

  it("clears when Tab cycles back to the warm effort before sending", () => {
    const c = new ColdCacheTracker();
    c.requestSent("openai-codex", "m", "high", T0);
    c.replied();
    c.effortChanged("openai-codex", "m", "xhigh", T0 + 1);
    c.effortChanged("openai-codex", "m", "max", T0 + 2);
    expect(c.hint()).toBe(true);
    c.effortChanged("openai-codex", "m", "high", T0 + 3);
    expect(c.hint()).toBe(false);
  });

  it("keeps the hint when the effort changes again while the cold request is in flight", () => {
    const c = new ColdCacheTracker();
    c.requestSent("openai-codex", "m", "high", T0);
    c.replied();
    c.effortChanged("openai-codex", "m", "xhigh", T0 + 1);
    c.requestSent("openai-codex", "m", "xhigh", T0 + 2);
    c.effortChanged("openai-codex", "m", "low", T0 + 3);
    c.replied();
    expect(c.hint()).toBe(true);
  });

  it("drops the hint on a model change", () => {
    const c = new ColdCacheTracker();
    c.requestSent("openai", "m", "high", T0);
    c.effortChanged("openai", "m", "low", T0 + 1);
    c.modelChanged();
    expect(c.hint()).toBe(false);
  });

  it("knows a resumed conversation's efforts from its saved entries", () => {
    const c = new ColdCacheTracker();
    const at = (ms: number) => new Date(ms).toISOString();
    c.reset(
      sentFromEntries([
        { type: "message", timestamp: at(T0 - 10), message: { role: "assistant", provider: "openai-codex", model: "m", timestamp: T0 - 10 } },
        { type: "thinking_level_change", thinkingLevel: "high", timestamp: at(T0) },
        { type: "message", timestamp: at(T0 + 10), message: { role: "user" } },
        { type: "message", timestamp: at(T0 + 20), message: { role: "assistant", provider: "openai-codex", model: "m", timestamp: T0 + 20 } },
      ]),
    );
    c.effortChanged("openai-codex", "m", "high", T0 + 30);
    expect(c.hint()).toBe(false);
    c.effortChanged("openai-codex", "m", "medium", T0 + 40);
    expect(c.hint()).toBe(true);
  });
});
