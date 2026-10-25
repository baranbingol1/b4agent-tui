import { describe, expect, it } from "vitest";
import {
  lastRecorded,
  parseRateLimitEvent,
  parseRateLimitHeaders,
  parseUsagePayload,
  recordRateLimitHeaders,
  resetRecorded,
  sessionTotals,
  usageLines,
  windowLabel,
} from "../../src/extension/usage.js";

/** Recorded 2026-10-21 from a Pro account's `GET chatgpt.com/backend-api/wham/usage` (ids redacted). */
const LIVE_USAGE = {
  user_id: "user-REDACTED",
  account_id: "acc-REDACTED",
  email: "REDACTED",
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 17, limit_window_seconds: 604800, reset_after_seconds: 511980, reset_at: 1793091626 },
    secondary_window: null,
  },
  code_review_rate_limit: null,
  additional_rate_limits: null,
  model_usage: { "gpt-6-astra": { available: true, available_at: null, credits_would_enable: false } },
  credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: "62500.0000000000", approx_local_messages: [15625, 81250], approx_cloud_messages: [2500, 15625] },
  spend_control: { reached: false, individual_limit: null },
  rate_limit_reached_type: null,
  promo: null,
  rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 },
};

/** Recorded the same day from a `POST chatgpt.com/backend-api/codex/responses` (SSE). */
const LIVE_HEADERS = {
  "x-codex-active-limit": "premium",
  "x-codex-credits-balance": "62500.0000000000",
  "x-codex-credits-has-credits": "True",
  "x-codex-credits-unlimited": "False",
  "x-codex-plan-type": "pro",
  "x-codex-primary-over-secondary-limit-percent": "0",
  "x-codex-primary-reset-after-seconds": "511966",
  "x-codex-primary-reset-at": "1793091626",
  "x-codex-primary-used-percent": "17",
  "x-codex-primary-window-minutes": "10080",
  "x-codex-secondary-reset-after-seconds": "0",
  "x-codex-secondary-reset-at": "",
  "x-codex-secondary-used-percent": "0",
  "x-codex-secondary-window-minutes": "0",
  "x-oai-request-id": "d9e53ee4",
};

const weekly = { usedPercent: 17, windowMinutes: 10080, resetsAt: 1793091626 };

describe("wham/usage", () => {
  it("reads the live Pro shape: one weekly window, credits, plan", () => {
    expect(parseUsagePayload(LIVE_USAGE)).toEqual([
      { limitId: "codex", primary: weekly, limitReached: false, planType: "pro", credits: { hasCredits: true, unlimited: false, balance: "62500.0000000000" } },
    ]);
  });
  it("reads both windows and additional limits (Codex's client.rs test shape)", () => {
    const s = parseUsagePayload({
      plan_type: "plus",
      rate_limit: {
        primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 0, reset_at: 123 },
        secondary_window: { used_percent: 84, limit_window_seconds: 604800, reset_after_seconds: 0, reset_at: 456 },
      },
      additional_rate_limits: [{ limit_name: "GPT-6 Astra", metered_feature: "codex_other", rate_limit: { primary_window: { used_percent: 70, limit_window_seconds: 900, reset_at: 789 }, secondary_window: null } }],
    });
    expect(s.map((x) => [x.limitId, x.primary?.windowMinutes, x.primary?.usedPercent, x.secondary?.windowMinutes])).toEqual([
      ["codex", 300, 42, 10080],
      ["codex_other", 15, 70, undefined],
    ]);
    expect(s[1]!.limitName).toBe("GPT-6 Astra");
  });
  it("rounds a window's seconds up to minutes, as Codex does", () => {
    expect(parseUsagePayload({ rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 61, reset_at: 1 } } })[0]!.primary!.windowMinutes).toBe(2);
  });
});

describe("headers", () => {
  it("reads the live headers: a zeroed secondary window with an empty reset is absent", () => {
    expect(parseRateLimitHeaders(LIVE_HEADERS)).toEqual([
      { limitId: "codex", primary: weekly, credits: { hasCredits: true, unlimited: false, balance: "62500.0000000000" }, planType: "pro" },
    ]);
  });
  it("finds other limit families and their names, codex first (rate_limits.rs)", () => {
    const s = parseRateLimitHeaders({
      "X-Codex-Bengalfox-Primary-Used-Percent": "80",
      "x-codex-bengalfox-limit-name": "gpt-5.2-codex-sonic",
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
    });
    expect(s.map((x) => [x.limitId, x.limitName, x.primary?.usedPercent])).toEqual([
      ["codex", undefined, 12.5],
      ["codex_bengalfox", "gpt-5.2-codex-sonic", 80],
    ]);
  });
  it("only records responses that carry limits", () => {
    resetRecorded();
    recordRateLimitHeaders({ "content-type": "text/event-stream" });
    expect(lastRecorded()).toBeUndefined();
    recordRateLimitHeaders(LIVE_HEADERS, 1000);
    expect(lastRecorded()?.limits[0]?.primary).toEqual(weekly);
  });
  it("reads the WebSocket codex.rate_limits event", () => {
    expect(parseRateLimitEvent({ type: "codex.rate_limits", plan_type: "plus", rate_limits: { primary: { used_percent: 5, window_minutes: 300, reset_at: 9 }, secondary: null } })).toEqual({
      limitId: "codex",
      primary: { usedPercent: 5, windowMinutes: 300, resetsAt: 9 },
      planType: "plus",
    });
    expect(parseRateLimitEvent({ type: "response.created" })).toBeUndefined();
  });
});

describe("display", () => {
  it("names windows by length, not slot", () => {
    expect([300, 10080, 1440, 43200, 90, undefined].map(windowLabel)).toEqual(["5-hour", "weekly", "daily", "30-day", "90-minute", "limit"]);
  });
  it("shows shorter windows first, used percent, time to reset, credits, session totals", () => {
    const limits = parseUsagePayload({
      plan_type: "plus",
      credits: { has_credits: true, unlimited: false, balance: "1234.5" },
      rate_limit: {
        primary_window: { used_percent: 95, limit_window_seconds: 604800, reset_at: 1_000_000 + 2 * 86400 + 3 * 3600 },
        secondary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1_000_000 + 90 * 60 },
      },
    });
    const totals = sessionTotals([
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", usage: { input: 1200, output: 300, cacheRead: 50_000, cacheWrite: 0, totalTokens: 51_500, cost: { total: 0.125 } } } },
      { type: "message", message: { role: "assistant", provider: "openai-codex", model: "gpt-6-luna", usage: { input: 800, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 900, cost: { total: 0.01 } } } },
      { type: "thinking_level_change", thinkingLevel: "high" },
    ]);
    const text = usageLines({ limits, totals, source: "live" }, 1_000_000 * 1000).join("\n");
    expect(text).toMatch(/ChatGPT plan limits \(plus\)/);
    expect(text.indexOf("5-hour")).toBeLessThan(text.indexOf("weekly"));
    expect(text).toMatch(/5-hour .* 30% used .*\(in 1h 30m\)/);
    expect(text).toMatch(/weekly .* 95% used .*\(in 2d 3h\)/);
    expect(text).toMatch(/credits +1,234\.5/);
    expect(text).toMatch(/2 turns · input 2\.0k · output 400 · cache read 50k/);
    expect(text).toMatch(/cost \$0\.14/);
    expect(text).toMatch(/openai-codex\/gpt-6-luna: 1 turns, 900 tokens/);
  });
  it("says why there are no limits", () => {
    expect(usageLines({ totals: sessionTotals([]), note: "no openai-codex login" }).join("\n")).toMatch(/no openai-codex login[\s\S]*no model turns yet/);
  });
});
