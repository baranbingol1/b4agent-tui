import { parse, forEachChild, type SyntaxNode, type Command, type Redirection, type Assignment, type CommandNode, type ParsedScript } from "unbash";
import { posix } from "node:path";
import { type Arg, wordToArg, staticValue, literalArg, isDynamic } from "./words.js";
import { unwrap, headName, SHELLS, type Nested } from "./unwrap.js";
import { expandHome } from "../paths.js";

export const MAX_DEPTH = 8;

export interface Redir {
  op: string;
  target: Arg | undefined;
  /** Body of a heredoc, or the word of a herestring. */
  input?: string;
}

/** One simple command, after unwrapping, with the context it runs in. */
export interface ShellCommand {
  argv: Arg[];
  /** Wrappers stripped from the front, outermost first. */
  wrappers: string[];
  privileged: boolean;
  redirects: Redir[];
  /** Directory the command runs in. Undefined after a `cd` we could not follow. */
  cwd: string | undefined;
  depth: number;
  /** How we reached it: "top", "$()", "sh -c", "eval", "find -exec", "xargs", "heredoc", ... */
  via: string;
  /** Position in a pipeline. */
  pipe?: { id: number; index: number; count: number };
  /** A nested script we could not read (dynamic `sh -c "$X"`, `eval "$(...)"`). */
  opaque?: { via: string; payload: Arg | undefined };
  /** Source text of the command as written. */
  text: string;
  /** Variables the script assigned that are visible to this command. Inherited ones are not listed. */
  vars: ReadonlyMap<string, VarInfo>;
  /** The command name came from variables (`$T`); this is how it was written. */
  resolvedFrom?: string;
}

export type VarInfo =
  | { kind: "literal"; value: string }
  | { kind: "nonEmpty" }
  /** A `for` variable over a static list: one of these words (literals and globs). */
  | { kind: "oneOf"; words: Arg[] }
  | { kind: "unknown" };

const UNKNOWN: VarInfo = { kind: "unknown" };

/**
 * Shell variables as the shell sees them at one point of the script.
 * Subshells, pipeline stages and `$(...)` get a child scope whose assignments
 * are dropped; a nested shell (`sh -c`) also sees only exported variables.
 * Conditional branches and loops merge back: a variable that may or may not
 * have changed becomes unknown.
 */
export class Scope {
  readonly vars = new Map<string, { info: VarInfo; exported: boolean }>();
  constructor(readonly parent?: Scope, readonly process = false) {}

  /** Undefined when the script never assigns the name (it comes from the environment, or is unset). */
  lookup(name: string): VarInfo | undefined {
    let crossed = false;
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const b = s.vars.get(name);
      if (b) return crossed && !b.exported ? UNKNOWN : b.info;
      if (s.process) crossed = true;
    }
    return undefined;
  }

  private exported(name: string): boolean {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const b = s.vars.get(name);
      if (b) return b.exported;
    }
    return false;
  }

  set(name: string, info: VarInfo, exported = false): void {
    this.vars.set(name, { info, exported: exported || this.exported(name) });
  }

  /** Every variable the script assigned that is visible here. */
  visible(): ReadonlyMap<string, VarInfo> {
    const names = new Set<string>();
    for (let s: Scope | undefined = this; s; s = s.parent) for (const n of s.vars.keys()) names.add(n);
    const out = new Map<string, VarInfo>();
    for (const n of names) out.set(n, this.lookup(n)!);
    return out;
  }

  /** Folds a branch that may not have run back into this scope. */
  merge(branch: Scope): void {
    for (const [name, b] of branch.vars) {
      const prev = this.lookup(name);
      this.set(name, prev && JSON.stringify(prev) === JSON.stringify(b.info) ? b.info : UNKNOWN, b.exported);
    }
  }
}

export interface FunctionDef {
  name: string;
  /** The body calls the function itself inside a pipeline or in the background (a fork bomb). */
  forks: boolean;
}

export interface Extraction {
  commands: ShellCommand[];
  functions: FunctionDef[];
  errors: string[];
  tooDeep: boolean;
}

interface State {
  cwd: string | undefined;
  depth: number;
  via: string;
  pipe?: ShellCommand["pipe"];
  scope: Scope;
}

/** Plain words a variable may hold for its expansion to name a command: no quotes, globs, `~` or shell syntax. */
const PLAIN_WORDS = /^[A-Za-z0-9_./:@%+,=-]+([ \t]+[A-Za-z0-9_./:@%+,=-]+)*$/;
/** Builtins that change variables or run their arguments as code: a variable never names them. */
const NOT_FROM_VARIABLE = new Set([
  "export", "local", "declare", "typeset", "readonly", "read", "mapfile", "readarray", "printf", "getopts", "let", "unset", "set",
  "eval", "source", ".", "alias", "cd", "pushd", "popd", "builtin", "command", "exec", "trap", "shopt",
]);

/**
 * Parses a bash command line into every simple command it would run,
 * including the ones inside substitutions, `sh -c`, `eval`, heredocs fed to a
 * shell, `find -exec` and `xargs`.
 */
export function extract(source: string, cwd: string, home: string): Extraction {
  const out: Extraction = { commands: [], functions: [], errors: [], tooDeep: false };
  let pipeIds = 0;

  const varInfo = (a: Assignment): VarInfo => {
    if (a.value.type !== "Word" || a.append || a.index) return UNKNOWN;
    const arg = wordToArg(a.value);
    const v = staticValue(arg);
    if (v !== undefined) return { kind: "literal", value: v };
    const s = arg.segments;
    if (s.length === 1 && s[0]!.kind === "cmd" && /^\$\(\s*mktemp\b|^`\s*mktemp\b/.test(s[0]!.text)) return { kind: "nonEmpty" };
    return UNKNOWN;
  };

  const runScript = (script: ParsedScript, src: string, st: State) => {
    if (st.depth > MAX_DEPTH) {
      out.tooDeep = true;
      return;
    }
    for (const e of script.errors ?? []) out.errors.push(e.message);
    visit(script, src, st);
  };

  const parseNested = (text: string, st: State) => {
    const ast = parse(text);
    runScript(ast, ast.source ?? text, st);
  };

  const record = (cmd: Omit<ShellCommand, "depth" | "cwd" | "via" | "pipe" | "vars">, st: State) => {
    out.commands.push({ ...cmd, depth: st.depth, cwd: st.cwd, via: st.via, vars: st.scope.visible(), ...(st.pipe ? { pipe: st.pipe } : {}) });
  };

  /** A child state whose variable changes are dropped. A new process also hides unexported variables. */
  const isolated = (st: State, over: Partial<State> = {}, process = false): State => ({ ...st, ...over, scope: new Scope(st.scope, process) });

  /** Runs a part that may not run (a branch, a loop body), then folds its changes back. */
  const maybe = (st: State, run: (inner: State) => void) => {
    const inner = isolated(st);
    run(inner);
    st.scope.merge(inner.scope);
    st.cwd = inner.cwd;
  };

  const handleNested = (n: Nested, st: State, text: string) => {
    // `eval` runs in this shell and `find -exec`/`xargs` words were expanded by it; the rest start a new shell.
    const scope = n.kind === "argv" || n.via === "eval" ? st.scope : new Scope(st.scope, n.via !== "trap");
    const inner: State = { ...st, depth: st.depth + 1, via: n.via, pipe: undefined, scope };
    if (inner.depth > MAX_DEPTH) {
      out.tooDeep = true;
      return;
    }
    if (n.kind === "script") {
      if (n.script !== undefined) parseNested(n.script, inner);
      else record({ argv: [], wrappers: [], privileged: false, redirects: [], text, opaque: { via: n.via, payload: n.payload } }, inner);
      return;
    }
    emitArgv(n.argv, [], inner, text);
  };

  const emitArgv = (argv: Arg[], redirects: Redir[], st: State, text: string, resolvedFrom?: string) => {
    const u = unwrap(argv);
    record({ argv: u.argv, wrappers: u.wrappers, privileged: u.privileged, redirects, text, ...(resolvedFrom ? { resolvedFrom } : {}) }, st);
    for (const n of u.nested) handleNested(n, st, text);

    // Heredoc or herestring fed to a shell that reads stdin: parse the input.
    const head = headName(u.argv[0]);
    if (head && SHELLS.has(head) && u.argv.length === 1) {
      for (const r of redirects) if (r.input !== undefined) parseNested(r.input, { ...isolated(st, {}, true), depth: st.depth + 1, via: "heredoc", pipe: undefined });
    }

    // `cd` changes where later relative paths point.
    if (head === "cd" || head === "pushd") {
      const target = u.argv.slice(1).find((a) => staticValue(a) !== "--" && !(staticValue(a) ?? "x").startsWith("-"));
      if (!target) st.cwd = home;
      else {
        const v = staticValue(target);
        if (v === undefined || v === "-") st.cwd = undefined;
        else {
          const e = expandHome(v, home);
          st.cwd = e.startsWith("/") ? posix.normalize(e) : st.cwd === undefined ? undefined : posix.resolve(st.cwd, e);
        }
      }
    }
  };

  /**
   * `T="npx tuistory"; $T type hi` and `E=/opt/x; "$E/bin/pi"`: a command name
   * built only from variables this script set to plain words resolves to those
   * words, split like the shell splits an unquoted expansion. Anything else
   * (inherited, dynamic, changed in a branch or loop) stays unresolved.
   */
  const resolveHead = (name: Arg, scope: Scope): Arg[] | undefined => {
    const words: string[] = [""];
    let sawVar = false;
    for (const seg of name.segments) {
      if (seg.kind === "lit") { words[words.length - 1] += seg.value; continue; }
      if (seg.kind !== "var") return undefined;
      const v = scope.lookup(seg.name);
      if (v?.kind !== "literal" || !PLAIN_WORDS.test(v.value.trim())) return undefined;
      sawVar = true;
      if (seg.quoted) { words[words.length - 1] += v.value; continue; }
      const parts = v.value.trim().split(/[ \t]+/);
      const lead = /^[ \t]/.test(v.value);
      const trail = /[ \t]$/.test(v.value);
      parts.forEach((p, i) => {
        if (i > 0 || (lead && words[words.length - 1] !== "")) words.push("");
        words[words.length - 1] += p;
      });
      if (trail) words.push("");
    }
    const argv = words.filter((w) => w !== "").map(literalArg);
    if (!sawVar || argv.length === 0 || NOT_FROM_VARIABLE.has(headName(argv[0]) ?? "")) return undefined;
    return argv;
  };

  const redirectsOf = (rs: readonly Redirection[]): Redir[] =>
    rs.map((r) => {
      if (r.type === "HereDoc") return { op: r.operator, target: undefined, input: r.body.text };
      if (r.type === "HereString") return { op: r.operator, target: undefined, input: r.target ? staticValue(wordToArg(r.target)) : undefined };
      return { op: r.operator, target: r.target ? wordToArg(r.target) : undefined };
    });

  const visitCommand = (c: Command, src: string, st: State) => {
    // Substitutions inside words and assignments run first, in a subshell.
    const sub: State = { ...isolated(st), depth: st.depth + 1, via: "$()", pipe: undefined };
    forEachChild(c as unknown as SyntaxNode, (child) => visitSubstitutions(child, src, sub));

    for (const p of c.prefix) if (p.type === "Assignment" && !c.name) st.scope.set(p.name, varInfo(p));

    if (!c.name) return;
    const name = wordToArg(c.name);
    const resolved = isDynamic(name) ? resolveHead(name, st.scope) : undefined;
    const argv: Arg[] = resolved ?? [name];
    for (const a of c.args) {
      if (a.type === "Word") argv.push(wordToArg(a));
      else {
        argv.push(literalArg(a.text));
        const h = headName(argv[0]);
        if (h === "export" || h === "local" || h === "declare" || h === "typeset" || h === "readonly") st.scope.set(a.name, varInfo(a), h === "export");
      }
    }
    if (headName(argv[0]) === "read") for (const a of argv.slice(1)) {
      const v = staticValue(a);
      if (v && !v.startsWith("-")) st.scope.set(v, UNKNOWN);
    }
    emitArgv(argv, redirectsOf(c.redirects), st, src.slice(c.pos, c.end), resolved ? name.text : undefined);
  };

  /** Finds `$(...)`, backticks and `<(...)` scripts under a node and runs them. */
  const visitSubstitutions = (node: SyntaxNode, src: string, st: State) => {
    if (node.type === "CommandExpansion" || node.type === "ProcessSubstitution") {
      const script = (node as { script?: ParsedScript }).script;
      if (script) runScript(script, script.source ?? src, st);
      return;
    }
    if (node.type === "Statement" || node.type === "Script") return;
    forEachChild(node, (child) => visitSubstitutions(child, src, st));
  };

  /** Loop bodies run again after a later assignment, so whatever they assign is unknown from the start. */
  const forgetAssigned = (nodes: (SyntaxNode | undefined)[], st: State) => {
    for (const n of nodes) if (n) for (const name of assignedNames(n)) st.scope.set(name, UNKNOWN);
  };

  const visit = (node: SyntaxNode, src: string, st: State): void => {
    switch (node.type) {
      case "Command":
        visitCommand(node, src, st);
        return;
      case "Statement":
        if (node.background) {
          visit(node.command as SyntaxNode, src, isolated(st));
          return;
        }
        break;
      case "AndOr":
        node.commands.forEach((part, i) => {
          if (i === 0) visit(part as SyntaxNode, src, st);
          else maybe(st, (inner) => visit(part as SyntaxNode, src, inner));
        });
        return;
      case "If":
        visit(node.clause as SyntaxNode, src, st);
        maybe(st, (inner) => visit(node.then as SyntaxNode, src, inner));
        for (const e of node.elif) maybe(st, (inner) => visit(e as SyntaxNode, src, inner));
        if (node.else) maybe(st, (inner) => visit(node.else as SyntaxNode, src, inner));
        return;
      case "Case":
        visit(node.word as SyntaxNode, src, st);
        for (const item of node.items) maybe(st, (inner) => visit(item as SyntaxNode, src, inner));
        return;
      case "While":
        forgetAssigned([node.clause as SyntaxNode, node.body as SyntaxNode], st);
        maybe(st, (inner) => {
          visit(node.clause as SyntaxNode, src, inner);
          visit(node.body as SyntaxNode, src, inner);
        });
        return;
      case "Pipeline": {
        const id = ++pipeIds;
        const count = node.commands.length;
        const before = out.commands.length;
        node.commands.forEach((stage: CommandNode, index) => {
          const saved = st.cwd;
          visit(stage as SyntaxNode, src, { ...isolated(st), pipe: { id, index, count } });
          st.cwd = saved;
        });
        feedShellsFromPipe(out.commands.slice(before), id, st);
        return;
      }
      case "Subshell":
      case "Coproc": {
        const saved = st.cwd;
        visit(node.body as SyntaxNode, src, { ...isolated(st), pipe: undefined });
        st.cwd = saved;
        return;
      }
      case "Function": {
        out.functions.push({ name: node.name.value, forks: forks(node.body as SyntaxNode, node.name.value) });
        // A later call can set anything the body assigns.
        forgetAssigned([node.body as SyntaxNode], st);
        const saved = st.cwd;
        visit(node.body as SyntaxNode, src, { ...isolated(st), pipe: undefined });
        st.cwd = saved;
        return;
      }
      case "For":
      case "Select": {
        const words = (node.wordlist ?? []).map(wordToArg);
        for (const w of node.wordlist ?? []) visitSubstitutions(w as SyntaxNode, src, { ...isolated(st), depth: st.depth + 1, via: "$()", pipe: undefined });
        forgetAssigned([node.body as SyntaxNode], st);
        const fixed = words.length > 0 && words.every((w) => w.segments.every((seg) => seg.kind === "lit" || seg.kind === "glob"));
        st.scope.set(node.name.value, fixed && node.type === "For" ? { kind: "oneOf", words } : UNKNOWN);
        maybe(st, (inner) => visit(node.body as SyntaxNode, src, inner));
        return;
      }
      case "Redirected": {
        const rs = redirectsOf(node.redirects);
        for (const r of rs) if (r.target) record({ argv: [], wrappers: [], privileged: false, redirects: [r], text: src.slice(node.pos, node.end) }, st);
        break;
      }
    }
    // Words in compound commands (for-lists, case words, test expressions) can hold substitutions.
    if (node.type === "Word") {
      visitSubstitutions(node, src, { ...isolated(st), depth: st.depth + 1, via: "$()", pipe: undefined });
      return;
    }
    forEachChild(node, (child) => visit(child, src, st));
  };

  /** `cat <<EOF | sh` and `echo 'cmd' | bash`: parse what the shell reads. */
  const feedShellsFromPipe = (cmds: ShellCommand[], id: number, st: State) => {
    const stages = cmds.filter((c) => c.pipe?.id === id && c.depth === st.depth);
    for (const c of stages) {
      const head = headName(c.argv[0]);
      if (!head || !SHELLS.has(head) || c.argv.length !== 1 || !c.pipe || c.pipe.index === 0) continue;
      const prev = stages.find((p) => p.pipe!.index === c.pipe!.index - 1);
      if (!prev) continue;
      const ph = headName(prev.argv[0]);
      let text: string | undefined;
      if (ph === "cat" && prev.argv.length === 1) text = prev.redirects.find((r) => r.input !== undefined)?.input;
      else if (ph === "echo" || ph === "printf") {
        const parts = prev.argv.slice(1).map(staticValue);
        if (parts.every((p) => p !== undefined) && !(parts[0] ?? "").startsWith("-")) text = parts.join(" ");
      }
      if (text !== undefined) parseNested(text, { ...isolated(st, {}, true), depth: st.depth + 1, via: "pipe to shell", pipe: undefined });
    }
  };

  const ast = parse(source);
  runScript(ast, ast.source ?? source, { cwd, depth: 0, via: "top", scope: new Scope() });
  return out;
}

/** Names a part of the script may assign: assignments, `for` variables and `read` targets. */
function assignedNames(node: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const walk = (n: SyntaxNode) => {
    if (n.type === "Assignment") names.add(n.name);
    else if (n.type === "For" || n.type === "Select") names.add(n.name.value);
    else if (n.type === "Command" && n.name?.value === "read") {
      for (const a of n.args) if (a.type === "Word" && !a.value.startsWith("-")) names.add(a.value);
    }
    forEachChild(n, walk);
  };
  walk(node);
  return names;
}

/** Does a function body call itself in a pipeline or in the background (a fork bomb)? */
function forks(body: SyntaxNode, name: string): boolean {
  let found = false;
  const walk = (n: SyntaxNode, inPipeOrBg: boolean) => {
    if (found) return;
    if (n.type === "Command") {
      if (inPipeOrBg && n.name?.value === name) found = true;
      return;
    }
    const next = inPipeOrBg || (n.type === "Pipeline" && n.commands.length > 1) || (n.type === "Statement" && n.background === true);
    forEachChild(n, (c) => walk(c, next));
  };
  walk(body, false);
  return found;
}
