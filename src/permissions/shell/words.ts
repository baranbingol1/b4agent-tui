import type { Word, WordPart, DoubleQuotedChild, ParameterExpansionPart } from "unbash";

/**
 * A shell word flattened into static and dynamic pieces. Quotes are already
 * removed by unbash; what remains is what the shell would substitute.
 */
export type Segment =
  | { kind: "lit"; value: string }
  /** `$X`, `${X}`, `${X:-d}` and friends. `nonEmpty` when the expansion can never be empty. */
  | { kind: "var"; name: string; text: string; nonEmpty: boolean; fallback?: string; quoted?: boolean }
  | { kind: "cmd"; text: string }
  | { kind: "glob"; text: string }
  | { kind: "other"; text: string };

export interface Arg {
  text: string;
  segments: Segment[];
}

export function wordToArg(word: Word): Arg {
  const segments: Segment[] = [];
  if (!word.parts) segments.push({ kind: "lit", value: word.value });
  else for (const p of word.parts) pushPart(p, segments);
  return { text: word.text, segments: merge(segments) };
}

export function literalArg(value: string): Arg {
  return { text: value, segments: [{ kind: "lit", value }] };
}

function pushPart(p: WordPart | DoubleQuotedChild, out: Segment[], quoted = false): void {
  switch (p.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      out.push({ kind: "lit", value: p.value });
      return;
    case "DoubleQuoted":
    case "LocaleString":
      for (const c of p.parts) pushPart(c, out, true);
      return;
    case "SimpleExpansion":
      out.push({ kind: "var", name: p.text.slice(1), text: p.text, nonEmpty: false, ...(quoted ? { quoted } : {}) });
      return;
    case "ParameterExpansion":
      out.push({ ...parameter(p), ...(quoted ? { quoted } : {}) });
      return;
    case "CommandExpansion":
      out.push({ kind: "cmd", text: p.text });
      return;
    case "Glob":
      out.push({ kind: "glob", text: p.text });
      return;
    default:
      out.push({ kind: "other", text: p.text });
  }
}

function parameter(p: ParameterExpansionPart): Segment {
  const base = { kind: "var" as const, name: p.parameter, text: p.text, nonEmpty: false };
  if (p.prefix || p.index) return base;
  const op = p.operation;
  if (!op) return base;
  if (op.type === "Default") {
    // ${X:?} aborts on unset or empty, so the expansion is never empty.
    if (op.operator === ":?") return { ...base, nonEmpty: true };
    // ${X:-lit} / ${X:=lit} fall back to a literal when X is unset or empty.
    if ((op.operator === ":-" || op.operator === ":=") && isPlainLiteral(op.operand) && op.operand.value !== "") {
      return { ...base, nonEmpty: true, fallback: op.operand.value };
    }
  }
  return base;
}

function isPlainLiteral(w: Word): boolean {
  return !w.parts || w.parts.every((p) => p.type === "Literal" || p.type === "SingleQuoted");
}

function merge(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (s.kind === "lit" && last?.kind === "lit") last.value += s.value;
    else out.push(s.kind === "lit" ? { ...s } : s);
  }
  return out;
}

/** The value when the whole word is static. */
export function staticValue(arg: Arg): string | undefined {
  if (arg.segments.length === 0) return "";
  if (arg.segments.length === 1 && arg.segments[0]!.kind === "lit") return arg.segments[0]!.value;
  return undefined;
}

export function isDynamic(arg: Arg): boolean {
  return arg.segments.some((s) => s.kind !== "lit");
}
