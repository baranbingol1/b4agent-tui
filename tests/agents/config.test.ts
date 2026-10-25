import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROLES, loadB4Config, resolveModel, type ModelLookup } from "../../src/config.js";

const model = (provider: string, id: string) => ({ provider, id }) as never;
const lookup = (all: [string, string][], authed: string[]): ModelLookup => ({
  getAll: () => all.map(([p, i]) => model(p, i)),
  hasConfiguredAuth: (m: { provider: string }) => authed.includes(m.provider),
});

describe("model roles", () => {
  const models = lookup([["openai-codex", "gpt-6-luna"], ["openai", "gpt-6-luna"], ["anthropic", "claude-haiku-5-5"]], ["openai", "anthropic"]);

  it("skips candidates without a login and keeps the role's thinking", () => {
    const r = resolveModel("@smol", DEFAULT_ROLES, models);
    expect(r?.model).toMatchObject({ provider: "openai", id: "gpt-6-luna" });
    expect(r?.thinking).toBe("low");
  });

  it("thinking on the reference wins over the role's", () => {
    expect(resolveModel("@smol:high", DEFAULT_ROLES, models)?.thinking).toBe("high");
  });

  it("follows role chains and stops on cycles", () => {
    const roles = { a: ["@b"], b: ["anthropic/claude-haiku-5-5:medium"], loop: ["@loop"] };
    expect(resolveModel("@a", roles, models)).toMatchObject({ model: { id: "claude-haiku-5-5" }, thinking: "medium" });
    expect(resolveModel("@loop", roles, models)).toBeUndefined();
    expect(resolveModel("openai-codex/gpt-6-luna", roles, models)).toBeUndefined();
  });
});

describe("b4agent.json", () => {
  it("maps complexity levels, with per-level overrides", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4cfg-"));
    writeFileSync(join(dir, "b4agent.json"), JSON.stringify({ models: { complexity: { light: "fast", medium: "@worker", heavy: null, extreme: "@slow" } } }));
    const errors: string[] = [];
    const c = loadB4Config(dir, errors);
    // A bare role name means the role; null keeps the type's own model.
    expect(c.complexity).toEqual({ light: "@fast", medium: "@worker", heavy: undefined });
    expect(errors).toEqual(["models.complexity.extreme: use light, medium or heavy"]);
    expect(loadB4Config(mkdtempSync(join(tmpdir(), "b4cfg-"))).complexity).toEqual({ light: "@smol", medium: undefined, heavy: "@slow" });
  });

  it("merges roles over the defaults and reports bad fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4cfg-"));
    writeFileSync(join(dir, "b4agent.json"), JSON.stringify({ models: { roles: { smol: "anthropic/claude-haiku-5-5", bad: 3 } }, agents: { search: { thinking: "nope", max_turns: 12 } }, maxDepth: 1 }));
    const errors: string[] = [];
    const c = loadB4Config(dir, errors);
    expect(c.roles.smol).toEqual(["anthropic/claude-haiku-5-5"]);
    expect(c.roles.slow).toEqual(DEFAULT_ROLES.slow);
    expect(c.agents.search).toEqual({ maxTurns: 12 });
    expect(c.maxDepth).toBe(1);
    expect(c.jobs.autoBackgroundSeconds).toBe(60);
    expect(errors).toEqual(["models.roles.bad must be a string or a list of strings"]);
  });
});
