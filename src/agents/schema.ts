import Schema from "typebox/schema";

/**
 * Output schemas for `submit` (plan section 2, "Results"): a type's
 * `output` frontmatter or the `agent` call's `schema` is a JSON Schema the
 * child's `data` must match. Validation is typebox's JSON Schema checker.
 */
export type OutputSchema = Record<string, unknown> | boolean;

/** Reminders after a child ends without submitting; the last one also forces the submit tool (oh-my-pi). */
export const MAX_SUBMIT_REMINDERS = 3;

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SUBSCHEMA = ["items", "additionalProperties", "additionalItems", "not", "contains", "propertyNames", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"];
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const MAX_SCHEMA_CHARS = 16_000;

/**
 * Accepts a schema object (or its JSON text, as models sometimes send it)
 * and returns it, or an error string. The check is structural: a mistyped
 * `type` or `required` is caught here instead of silently accepting anything.
 */
export function parseOutputSchema(value: unknown): OutputSchema | string {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return "the output schema must be a JSON Schema object (got a string that isn't JSON)";
    }
  }
  if (typeof v === "boolean") return v;
  if (!v || typeof v !== "object" || Array.isArray(v)) return "the output schema must be a JSON Schema object";
  const size = JSON.stringify(v).length;
  if (size > MAX_SCHEMA_CHARS) return `the output schema is ${size} characters; keep it under ${MAX_SCHEMA_CHARS}`;
  const err = check(v as Record<string, unknown>, "#");
  if (err) return `the output schema is invalid at ${err}`;
  try {
    Schema.Compile(v as never);
  } catch (e) {
    return `the output schema is invalid: ${(e as Error).message}`;
  }
  return v as Record<string, unknown>;
}

function check(s: unknown, at: string): string | undefined {
  if (typeof s === "boolean") return undefined;
  if (!s || typeof s !== "object" || Array.isArray(s)) return `${at}: a schema must be an object or a boolean`;
  const o = s as Record<string, unknown>;
  if (o.type !== undefined) {
    const ts = Array.isArray(o.type) ? o.type : [o.type];
    const bad = ts.find((t) => typeof t !== "string" || !TYPES.has(t));
    if (bad !== undefined || !ts.length) return `${at}/type: ${JSON.stringify(bad ?? o.type)} is not a JSON Schema type (${[...TYPES].join(", ")})`;
  }
  if (o.required !== undefined && (!Array.isArray(o.required) || o.required.some((r) => typeof r !== "string"))) return `${at}/required: must be a list of property names`;
  for (const k of SUBSCHEMA) {
    if (o[k] === undefined) continue;
    // `items` may still be a list in older drafts.
    if (k === "items" && Array.isArray(o[k])) {
      for (const [i, x] of (o[k] as unknown[]).entries()) {
        const e = check(x, `${at}/items/${i}`);
        if (e) return e;
      }
      continue;
    }
    const e = check(o[k], `${at}/${k}`);
    if (e) return e;
  }
  for (const k of SUBSCHEMA_LISTS) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k])) return `${at}/${k}: must be a list of schemas`;
    for (const [i, x] of (o[k] as unknown[]).entries()) {
      const e = check(x, `${at}/${k}/${i}`);
      if (e) return e;
    }
  }
  for (const k of SUBSCHEMA_MAPS) {
    if (o[k] === undefined) continue;
    if (!o[k] || typeof o[k] !== "object" || Array.isArray(o[k])) return `${at}/${k}: must map names to schemas`;
    for (const [n, x] of Object.entries(o[k] as Record<string, unknown>)) {
      const e = check(x, `${at}/${k}/${n}`);
      if (e) return e;
    }
  }
  return undefined;
}

/** Validates `data` against the schema; returns readable errors, empty when it matches. */
export function validateOutput(schema: OutputSchema, data: unknown): string[] {
  const [ok, errors] = Schema.Errors(schema as never, data);
  if (ok) return [];
  // An additionalProperties: false failure is reported twice (once as "schema is false"); keep the clearer one.
  const extra = errors.some((e) => e.keyword === "additionalProperties");
  const lines = errors
    .filter((e) => !(extra && e.keyword === "boolean"))
    .map((e) => `${e.instancePath || "(root)"}: ${e.message}${e.keyword === "additionalProperties" ? ` (${String((e.params as { additionalProperties?: unknown[] }).additionalProperties ?? "")})` : ""}`);
  return [...new Set(lines)].slice(0, 12);
}

/**
 * The child's `data`, checked. Models sometimes send an object as its JSON
 * text, so a string that fails is retried parsed.
 */
export function checkSubmission(schema: OutputSchema, data: unknown): { data: unknown } | { errors: string[] } {
  const errors = validateOutput(schema, data);
  if (!errors.length) return { data };
  if (typeof data === "string") {
    try {
      const parsed: unknown = JSON.parse(data);
      if (!validateOutput(schema, parsed).length) return { data: parsed };
    } catch {
      // not JSON: report the original errors
    }
  }
  return { errors };
}

export function schemaBlock(schema: OutputSchema): string {
  return "```json\n" + JSON.stringify(schema, null, 2) + "\n```";
}

export function reminderText(n: number): string {
  return `[submit reminder ${n}/${MAX_SUBMIT_REMINDERS}] You ended your turn without calling submit. Your caller needs structured output: call submit with result (a short self-contained summary) and data matching the JSON Schema in your system prompt.${n === MAX_SUBMIT_REMINDERS ? " This is the last reminder; only submit is accepted now." : ""}`;
}

/**
 * The provider payload with the tool choice forced to one tool, or undefined
 * when the payload's API isn't recognised or can't force (Anthropic with
 * extended thinking). Pi has no forced tool choice of its own, so this goes
 * through `before_provider_request` for a single request.
 */
export function forceToolChoice(payload: unknown, tool: string): unknown {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const tools = Array.isArray(p.tools) ? (p.tools as Record<string, unknown>[]) : undefined;
  if (tools) {
    const has = (f: (t: Record<string, unknown>) => unknown) => tools.some((t) => f(t) === tool);
    // Anthropic Messages: forcing a tool is not allowed while thinking is on.
    if (tools.some((t) => "input_schema" in t)) {
      if (!has((t) => t.name)) return undefined;
      const thinking = p.thinking as { type?: string } | undefined;
      if (thinking && thinking.type !== "disabled") return undefined;
      return { ...p, tool_choice: { type: "tool", name: tool } };
    }
    // Chat Completions.
    if (has((t) => (t.function as { name?: string } | undefined)?.name)) return { ...p, tool_choice: { type: "function", function: { name: tool } } };
    // Responses (OpenAI, Codex, Azure): Codex accepts only auto / none / required, so declare just this tool and require a call.
    if (has((t) => (t.type === "function" ? t.name : undefined))) return { ...p, tools: tools.filter((t) => t.name === tool), tool_choice: "required", parallel_tool_calls: false };
    return undefined;
  }
  // Google Generative AI / Vertex.
  const config = p.config as Record<string, unknown> | undefined;
  const gTools = Array.isArray(config?.tools) ? (config!.tools as { functionDeclarations?: { name?: string }[] }[]) : undefined;
  if (gTools?.some((t) => t.functionDeclarations?.some((d) => d.name === tool))) {
    return { ...p, config: { ...config, toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool] } } } };
  }
  return undefined;
}
