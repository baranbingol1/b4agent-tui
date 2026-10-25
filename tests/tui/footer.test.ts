import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { assembleChips, renderFooter, STATUS, usageTotals, type FooterData } from "../../src/tui/footer.js";

/** Marks colours as `<color:text>` so tests can see them. */
const t = { fg: (c: string, s: string) => `<${c}:${s}>` };
const plain = { fg: (_c: string, s: string) => s };

describe("assembleChips", () => {
  it("orders known chips first, then other statuses by key, whatever order they were set in", () => {
    const statuses = new Map([
      ["zeta.other", "z"],
      [STATUS.recap, "recap…"],
      [STATUS.jobs, "2 jobs running"],
      ["alpha.ext", "a"],
      [STATUS.permissions, "auto mode"],
      [STATUS.spec, "spec mode"],
    ]);
    expect(assembleChips(statuses, plain)).toEqual(["auto mode", "spec mode", "2 jobs running", "recap…", "a", "z"]);
  });

  it("shows a status from an extension it has never heard of", () => {
    expect(assembleChips(new Map([["someone.new", "hello\nworld\t!"]]), plain)).toEqual(["hello world !"]);
  });

  it("drops empty statuses", () => {
    expect(assembleChips(new Map([["x", "  "], [STATUS.permissions, "auto mode"]]), plain)).toEqual(["auto mode"]);
  });

  it("colours the permission mode by mode and leaves a pre-coloured status alone", () => {
    expect(assembleChips(new Map([[STATUS.permissions, "YOLO mode"]]), t)).toEqual(["<error:YOLO mode>"]);
    expect(assembleChips(new Map([[STATUS.permissions, "manual mode"]]), t)).toEqual(["<success:manual mode>"]);
    expect(assembleChips(new Map([[STATUS.permissions, "auto mode"]]), t)).toEqual(["<accent:auto mode>"]);
    expect(assembleChips(new Map([[STATUS.spec, "\x1b[33mspec mode\x1b[39m"]]), t)).toEqual(["\x1b[33mspec mode\x1b[39m"]);
  });

  it("colours the changes chip's counts", () => {
    expect(assembleChips(new Map([[STATUS.changes, "Δ2 +14 −3"]]), t)).toEqual(["<muted:Δ2 ><success:+14><muted: ><error:−3>"]);
  });
});

const base: FooterData = {
  cwd: "/tmp/proj",
  branch: "main",
  usage: { input: 12_400, output: 1_100, cacheRead: 30_000, cacheWrite: 0, cost: 0, latestCacheHit: 95 },
  contextPercent: 45,
  model: { provider: "openai-codex", id: "gpt-6.1-sol", reasoning: true },
  thinking: "xhigh",
  subscription: true,
  providerCount: 2,
  statuses: new Map([[STATUS.permissions, "auto mode"]]),
  coldCache: false,
};

describe("renderFooter", () => {
  it("draws three lines: where, usage and model, chips", () => {
    const lines = renderFooter({ ...base, sessionName: "fix footer" }, 120, plain);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("/tmp/proj (main) • fix footer");
    expect(lines[1]).toMatch(/^12k in · 1.1k out · 95% cached · \$0\.000 sub · 45% context +\(openai-codex\) gpt-6\.1-sol • xhigh$/);
    expect(lines[1]).toHaveLength(120);
    expect(lines[2]).toBe("auto mode");
  });

  it("has no third line without statuses", () => {
    expect(renderFooter({ ...base, statuses: new Map() }, 120, plain)).toHaveLength(2);
  });

  it("shows the cold-cache hint after the effort, and keeps it when the provider has to go", () => {
    // (The test styler's markers count as visible text, hence the wide terminal.)
    expect(renderFooter({ ...base, coldCache: true }, 400, t)[1]).toContain("<warning:cold cache>");
    const narrow = renderFooter({ ...base, coldCache: true }, 90, plain)[1]!;
    expect(narrow).toMatch(/gpt-6\.1-sol • xhigh · cold cache$/);
    expect(narrow).not.toContain("(openai-codex)");
  });

  it("warns as the context fills up", () => {
    expect(renderFooter({ ...base, contextPercent: 75 }, 400, t)[1]).toContain("<warning:75% context>");
    expect(renderFooter({ ...base, contextPercent: 95 }, 400, t)[1]).toContain("<error:95% context>");
    expect(renderFooter({ ...base, contextPercent: null }, 120, plain)[1]).toContain("? context");
  });

  it("never draws wider than the terminal", () => {
    for (const w of [20, 40, 60]) for (const line of renderFooter({ ...base, coldCache: true, sessionName: "a long session name here" }, w, plain)) expect(visibleWidth(line)).toBeLessThanOrEqual(w);
  });
});

describe("usageTotals", () => {
  const usage = (input: number, cacheRead: number, cost = 0.01) => ({ input, output: 10, cacheRead, cacheWrite: 0, cost: { total: cost } });
  it("adds replies, tool usage and compactions, and takes the cache hit from the latest reply", () => {
    const u = usageTotals([
      { type: "message", message: { role: "assistant", usage: usage(100, 900) } },
      { type: "message", message: { role: "toolResult", usage: usage(5, 0) } },
      { type: "compaction", usage: usage(50, 0) },
      { type: "message", message: { role: "assistant", usage: usage(1000, 0) } },
      { type: "message", message: { role: "user" } },
    ]);
    expect(u.input).toBe(1155);
    expect(u.cacheRead).toBe(900);
    expect(u.cost).toBeCloseTo(0.04);
    expect(u.latestCacheHit).toBe(0);
  });
});
