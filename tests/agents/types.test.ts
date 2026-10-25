import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReadOnly, loadAgentTypes, modelCandidates, parseAgentType } from "../../src/agents/types.js";
import { DEFAULT_COMPLEXITY } from "../../src/config.js";

const type = (name: string, extra = "") => `---\nname: ${name}\ndescription: "${name}: from a test"\n${extra}---\nbody of ${name}\n`;

describe("agent types", () => {
  it("loads every builtin type without errors", () => {
    const errors: string[] = [];
    const types = loadAgentTypes({ b4agentDir: "/nonexistent", projectTrusted: false, overrides: {}, errors });
    expect(errors).toEqual([]);
    expect([...types.keys()].sort()).toEqual(["historian", "librarian", "reviewer", "search", "security-reviewer"]);
    expect(isReadOnly(types.get("search")!)).toBe(true);
    expect(types.get("search")?.locked).toBe(false);
  });

  it("user types override builtins, project types only when trusted, config last", () => {
    const home = mkdtempSync(join(tmpdir(), "b4types-"));
    const repo = join(home, "repo");
    mkdirSync(join(home, "agents"), { recursive: true });
    mkdirSync(join(repo, ".pi", "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "search.md"), type("search", 'model: "@slow"\n'));
    writeFileSync(join(repo, ".pi", "agents", "reviewer.md"), type("reviewer", "tools: read\n"));
    const base = { b4agentDir: home, projectRoot: repo, overrides: {} };
    const untrusted = loadAgentTypes({ ...base, projectTrusted: false });
    expect(untrusted.get("search")).toMatchObject({ model: "@slow", source: "user" });
    expect(untrusted.get("reviewer")?.source).toBe("builtin");
    const trusted = loadAgentTypes({ ...base, projectTrusted: true, overrides: { search: { model: "@smol", maxTurns: 5 } } });
    expect(trusted.get("reviewer")).toMatchObject({ source: "project", tools: ["read"] });
    // The override changes the model but keeps the user file's body.
    expect(trusted.get("search")).toMatchObject({ model: "@smol", prompt: "body of search" });
  });

  it("reports a broken file and keeps loading the rest", () => {
    const home = mkdtempSync(join(tmpdir(), "b4types-"));
    mkdirSync(join(home, "agents"));
    writeFileSync(join(home, "agents", "bad.md"), "---\nname: Bad Name\ndescription: x\n---\n");
    const errors: string[] = [];
    const types = loadAgentTypes({ b4agentDir: home, projectTrusted: false, overrides: { nope: {} }, errors });
    expect(types.has("reviewer")).toBe(true);
    expect(errors).toHaveLength(2);
  });
});

describe("output schema and locked in frontmatter", () => {
  it("parses a nested output schema and locked", () => {
    const t = parseAgentType(type("counter", "locked: true\noutput:\n  type: object\n  required: [n]\n  properties:\n    n: { type: integer }\n"), "user");
    expect(t).toMatchObject({ locked: true, output: { type: "object", required: ["n"], properties: { n: { type: "integer" } } } });
  });

  it("accepts the schema as JSON text and rejects a broken one", () => {
    expect(parseAgentType(type("a", `output: '{"type":"array","items":{"type":"string"}}'\n`), "user")).toMatchObject({ output: { type: "array" } });
    // "int" is not a JSON Schema type: typebox alone would accept anything here.
    expect(parseAgentType(type("b", "output:\n  type: object\n  properties:\n    n: { type: int }\n"), "user")).toMatch(/output: .*properties\/n\/type/);
    expect(parseAgentType(type("c", "output: [1, 2]\n"), "user")).toMatch(/must be a JSON Schema object/);
  });

  it("locked must be literally true", () => {
    expect(parseAgentType(type("d", 'locked: "yes"\n'), "user")).toMatchObject({ locked: false });
  });
});

describe("complexity and model overrides", () => {
  const base = parseAgentType(type("w", 'model: "@worker"\n'), "user");
  const locked = parseAgentType(type("o", 'model: "@slow"\nlocked: true\n'), "user");
  if (typeof base === "string" || typeof locked === "string") throw new Error("bad fixture");
  const config = { complexity: DEFAULT_COMPLEXITY };

  it("light → @smol, medium → the type's model, heavy → @slow, with the type's model as the fallback", () => {
    expect(modelCandidates(base, { complexity: "light" }, config)).toEqual(["@smol", "@worker"]);
    expect(modelCandidates(base, { complexity: "medium" }, config)).toEqual(["@worker"]);
    expect(modelCandidates(base, { complexity: "heavy" }, config)).toEqual(["@slow", "@worker"]);
    expect(modelCandidates(base, {}, config)).toEqual(["@worker"]);
  });

  it("an explicit model wins over complexity; config can remap a level", () => {
    expect(modelCandidates(base, { model: "openai/gpt-6.1-sol", complexity: "light" }, config)).toEqual(["openai/gpt-6.1-sol", "@smol", "@worker"]);
    expect(modelCandidates(base, { complexity: "medium" }, { complexity: { ...DEFAULT_COMPLEXITY, medium: "@main" } })).toEqual(["@main", "@worker"]);
  });

  it("a locked type ignores both", () => {
    expect(modelCandidates(locked, { model: "@smol", complexity: "light" }, config)).toEqual(["@slow"]);
  });
});
