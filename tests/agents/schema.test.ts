import { describe, expect, it } from "vitest";
import { checkSubmission, forceToolChoice, parseOutputSchema, reminderText } from "../../src/agents/schema.js";

const schema = { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } }, additionalProperties: false } as const;

describe("submit data", () => {
  it("reports where data is wrong, once per problem", () => {
    const r = checkSubmission(schema, { files: [1], extra: true });
    expect(r).toEqual({ errors: ["(root): must not have additional properties (extra)", "/files/0: must be string"] });
  });

  it("accepts matching data, and an object sent as JSON text", () => {
    expect(checkSubmission(schema, { files: ["a.ts"] })).toEqual({ data: { files: ["a.ts"] } });
    expect(checkSubmission(schema, '{"files":["a.ts"]}')).toEqual({ data: { files: ["a.ts"] } });
    // A string schema keeps the string as it is.
    expect(checkSubmission({ type: "string" }, '{"a":1}')).toEqual({ data: '{"a":1}' });
  });

  it("rejects schemas that would silently accept anything", () => {
    expect(parseOutputSchema({ type: "obj" })).toMatch(/#\/type/);
    expect(parseOutputSchema({ type: "object", required: "files" })).toMatch(/required/);
    expect(parseOutputSchema({ anyOf: [{ type: "string" }, { type: "map" }] })).toMatch(/anyOf\/1\/type/);
    expect(parseOutputSchema("not json")).toMatch(/isn't JSON/);
    expect(parseOutputSchema(JSON.stringify(schema))).toEqual(schema);
  });

  it("the last reminder says so", () => {
    expect(reminderText(1)).toContain("1/3");
    expect(reminderText(1)).not.toContain("last reminder");
    expect(reminderText(3)).toContain("last reminder");
  });
});

describe("forcing submit", () => {
  it("Responses (OpenAI, Codex): only submit is declared and a call is required", () => {
    const p = { model: "gpt", input: [], tools: [{ type: "function", name: "read" }, { type: "function", name: "submit" }] };
    expect(forceToolChoice(p, "submit")).toMatchObject({ tools: [{ name: "submit" }], tool_choice: "required" });
  });

  it("Chat Completions and Anthropic name the tool and keep the others (prompt cache)", () => {
    const chat = { messages: [], tools: [{ type: "function", function: { name: "read" } }, { type: "function", function: { name: "submit" } }] };
    expect(forceToolChoice(chat, "submit")).toMatchObject({ tools: chat.tools, tool_choice: { type: "function", function: { name: "submit" } } });
    const anthropic = { messages: [], tools: [{ name: "read", input_schema: {} }, { name: "submit", input_schema: {} }] };
    expect(forceToolChoice(anthropic, "submit")).toMatchObject({ tools: anthropic.tools, tool_choice: { type: "tool", name: "submit" } });
  });

  it("leaves what it can't force alone: Anthropic with thinking, unknown shapes, a missing tool", () => {
    expect(forceToolChoice({ thinking: { type: "enabled" }, tools: [{ name: "submit", input_schema: {} }] }, "submit")).toBeUndefined();
    expect(forceToolChoice({ prompt: "x" }, "submit")).toBeUndefined();
    expect(forceToolChoice({ tools: [{ type: "function", name: "read" }] }, "submit")).toBeUndefined();
  });

  it("Google: function calling mode ANY with only submit allowed", () => {
    const g = { contents: [], config: { tools: [{ functionDeclarations: [{ name: "submit" }] }] } };
    expect(forceToolChoice(g, "submit")).toMatchObject({ config: { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit"] } } } });
  });
});
