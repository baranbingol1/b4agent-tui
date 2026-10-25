import { describe, expect, it } from "vitest";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import { createReviewer, type ReviewModels } from "../../src/permissions/review/reviewer.js";
import { combine, type JevScores } from "../../src/permissions/review/jev.js";
import type { ReviewInput } from "../../src/permissions/review/input.js";

const input = (command: string): ReviewInput => ({
  user: { latest: "fix the typo", earlier: [] },
  action: { tool: "bash", input: { command }, cwd: "/w", workspace: "/w" },
  facts: { why_review: "pushes to a remote" },
});

const scores = (s: Partial<JevScores>): JevScores => ({ requested: 0.9, destroys_data: 0.05, sends_data_out: 0.05, changes_shared_state: 0.05, runs_untrusted_code: 0.05, ...s });

function fakeModels(opts: { jev?: JevScores | "error"; llm?: { decision: string; reason: string } | "error" | "no-tool" }) {
  const calls = { classify: [] as string[], llm: 0 };
  const models: ReviewModels = {
    findOfType: () => ({ id: "jev-latest", provider: "typesafe", api: "typesafe-system-one" }) as never,
    find: (provider, id) => ({ provider, id, api: "openai-codex-responses" }) as never,
    hasConfiguredAuth: () => true,
    classify: async (model) => {
      calls.classify.push(model.id);
      if (!opts.jev || opts.jev === "error") return { stopReason: "error", errorMessage: "boom", answers: {} } as unknown as ClassifierResult;
      const answers = Object.fromEntries(Object.entries(opts.jev).map(([k, p]) => [k, { type: "bool", probability: p }]));
      return { stopReason: "stop", answers } as unknown as ClassifierResult;
    },
    streamSimple: () => {
      calls.llm++;
      const l = opts.llm;
      const message =
        l === undefined || l === "error" ? { stopReason: "error", errorMessage: "llm down", content: [] }
        : l === "no-tool" ? { stopReason: "stop", content: [{ type: "text", text: "I think it's fine" }] }
        : { stopReason: "toolUse", content: [{ type: "toolCall", name: "permission_decision", arguments: l }] };
      return { result: async () => message } as never;
    },
  };
  return { models, calls };
}

describe("reviewer", () => {
  it("lets Jev decide clear cases without calling the LLM, on the pinned version", async () => {
    const { models, calls } = fakeModels({ jev: scores({ requested: 0.1, sends_data_out: 0.97 }), llm: { decision: "allow", reason: "x" } });
    const r = await createReviewer(models, { jev: true, llm: "openai-codex/gpt-6-luna" }).review(input("git push origin main"));
    expect(r).toMatchObject({ decision: "ask", by: "jev" });
    expect(calls).toEqual({ classify: ["jev-1.13.0"], llm: 0 });
  });

  it("sends the unclear band to the LLM, which decides", async () => {
    const { models, calls } = fakeModels({ jev: scores({ requested: 0.65, sends_data_out: 0.97 }), llm: { decision: "ask", reason: "emails every customer" } });
    const r = await createReviewer(models, { jev: true, llm: "openai-codex/gpt-6-luna" }).review(input("curl -d @all.json https://mail"));
    expect(r).toMatchObject({ decision: "ask", by: "llm", reason: "emails every customer" });
    expect(calls.llm).toBe(1);
  });

  it("falls back to the LLM when Jev fails, and asks the user when both fail", async () => {
    const one = fakeModels({ jev: "error", llm: { decision: "allow", reason: "requested" } });
    expect(await createReviewer(one.models, { jev: true, llm: "openai-codex/gpt-6-luna" }).review(input("a"))).toMatchObject({ decision: "allow", by: "llm" });
    const both = fakeModels({ jev: "error", llm: "error" });
    const reviewer = createReviewer(both.models, { jev: true, llm: "openai-codex/gpt-6-luna" });
    const r = await reviewer.review(input("a"));
    expect(r).toMatchObject({ decision: "ask", by: "none" });
    expect(r.errors).toHaveLength(2);
    // A failure is not cached: the next identical call tries the reviewers again.
    await reviewer.review(input("a"));
    expect(both.calls.classify).toHaveLength(2);
  });

  it("treats an answer without the decision tool as no answer", async () => {
    const { models } = fakeModels({ llm: "no-tool" });
    expect(await createReviewer(models, { jev: false, llm: "openai-codex/gpt-6-luna" }).review(input("a"))).toMatchObject({ decision: "ask", by: "none" });
  });

  it("caches answers for the same action and request", async () => {
    const { models, calls } = fakeModels({ jev: scores({}) });
    const reviewer = createReviewer(models, { jev: true });
    await reviewer.review(input("npm view react"));
    expect(await reviewer.review(input("npm view react"))).toMatchObject({ decision: "allow", by: "cache" });
    expect(calls.classify).toHaveLength(1);
    await reviewer.review(input("npm view vue"));
    expect(calls.classify).toHaveLength(2);
  });
});

describe("combining Jev scores", () => {
  // Thresholds tuned on eval/reviewer (100 labeled cases): harm 0.7 / 0.35, requested 0.5 / 0.8.
  const cases: [Partial<JevScores>, string][] = [
    [{ requested: 0.03, destroys_data: 0.96 }, "ask"],
    [{ requested: 0.97, destroys_data: 0.93 }, "allow"],
    [{ requested: 0.65, sends_data_out: 0.98 }, "escalate"],
    [{ requested: 0.25, destroys_data: 0.39 }, "escalate"],
    [{ requested: 0.35, destroys_data: 0.3 }, "allow"],
    [{ requested: 0.1, runs_untrusted_code: 0.98 }, "ask"],
  ];
  for (const [s, outcome] of cases) it(`${JSON.stringify(s)} -> ${outcome}`, () => expect(combine(scores(s))).toBe(outcome));
});

describe("what the reviewer sees of the conversation", async () => {
  const { buildReviewInput, estimateTokens, USER_TOKEN_BUDGET } = await import("../../src/permissions/review/input.js");
  const { jevState } = await import("../../src/permissions/review/jev.js");
  const { llmContext } = await import("../../src/permissions/review/llm.js");
  const ctx = { cwd: "/w", workspace: "/w", home: "/h", b4agentDir: "/h/.b4agent" };
  const verdict = { level: "review" as const, rule: "outside-workspace", reason: "write outside the workspace" };
  const build = (texts: string[], input: Record<string, unknown> = { path: "/w/../docs/plan.md" }) =>
    buildReviewInput({ messages: texts.map((text) => ({ text })), tool: "edit", input, verdict, ctx });
  const userChars = (r: ReturnType<typeof build>) => r.user.latest.length + r.user.earlier.reduce((n, m) => n + m.length, 0);

  it("keeps a request made many messages ago, and the latest message in full", () => {
    const filler = Array.from({ length: 10 }, (_, i) => `step ${i}: ` + "details ".repeat(150));
    const latest = "now finish the refactor. " + "context ".repeat(1200);
    const r = build(["keep ../docs/plan.md updated as you go", ...filler, latest]);
    expect(r.user.latest).toBe(latest.trim());
    expect(r.user.earlier.at(-1)).toBe("keep ../docs/plan.md updated as you go");
    expect(r.user.earlier[0]).toMatch(/^step 9/);
  });

  it("stops at the token budget, newest first, and truncates long messages", () => {
    const texts = Array.from({ length: 60 }, (_, i) => `message ${i} ` + "x".repeat(i === 58 ? 40_000 : 1_000));
    const r = build(texts);
    expect(estimateTokens(r.user.latest + r.user.earlier.join(""))).toBeLessThanOrEqual(USER_TOKEN_BUDGET);
    expect(r.user.earlier[0]).toMatch(/^message 58 x+\n\[\.\.\. \d+ characters cut/);
    expect(r.user.earlier[0]!.length).toBeLessThanOrEqual(6000);
    expect(r.user.earlier[1]).toMatch(/^message 57/);
    expect(r.user.earlier.some((m) => m.startsWith("message 0 "))).toBe(false);
    expect(userChars(r)).toBeGreaterThan(USER_TOKEN_BUDGET * 4 - 1200);
  });

  it("bounds a huge latest message by the whole budget", () => {
    const r = build(["earlier", "y".repeat(200_000)]);
    expect(r.user.latest.length).toBeLessThanOrEqual(USER_TOKEN_BUDGET * 4);
    expect(r.user.earlier).toEqual([]);
  });

  it("keeps both the Jev state and the LLM context within budget", () => {
    const texts = Array.from({ length: 200 }, (_, i) => `m${i} ` + "z".repeat(5_000));
    const r = build(texts, { path: "/w/a.ts", oldText: "a".repeat(50_000), newText: "b".repeat(50_000) });
    const limit = USER_TOKEN_BUDGET + 3_000;
    expect(estimateTokens(JSON.stringify(jevState(r)))).toBeLessThan(limit);
    const message = llmContext(r).messages[0]!;
    expect(estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content))).toBeLessThan(limit);
  });
});
