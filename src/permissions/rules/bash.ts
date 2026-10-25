import { posix } from "node:path";
import { extract, type Extraction, type ShellCommand } from "../shell/commands.js";
import { type Arg, staticValue, isDynamic } from "../shell/words.js";
import { headName, SHELLS } from "../shell/unwrap.js";
import {
  PLACEHOLDER, classifyRead, classifyWrite, isCriticalPath, isCredentialPath, isOwnGuardPath, resolvePath,
} from "../paths.js";
import { type PermissionContext, type Verdict, strictest } from "../types.js";
import { regexFallback } from "./fallback.js";

const MAX_LENGTH = 10_000;
const ALLOW: Verdict = { level: "allow", rule: "neutral", reason: "no effect beyond the shell" };

/** Classifies one bash tool call. The strictest verdict of every command inside wins. */
export function classifyBash(command: string, ctx: PermissionContext): Verdict {
  const out: Verdict[] = [];
  if (INVISIBLE.test(command)) out.push({ level: "ask", rule: "invisible-unicode", reason: "the command contains invisible or bidirectional Unicode characters" });

  if (command.length > MAX_LENGTH) {
    out.push(regexFallback(command) ?? { level: "review", rule: "too-long", reason: `command is over ${MAX_LENGTH} characters` });
    return strictest(out, ALLOW);
  }

  const ext = extract(command, ctx.cwd, ctx.home);
  if (ext.errors.length) {
    out.push(regexFallback(command) ?? { level: "review", rule: "unparseable", reason: `could not parse the command: ${ext.errors[0]}` });
  }
  if (ext.tooDeep) out.push({ level: "ask", rule: "too-deep", reason: "commands nested more than 8 levels deep" });
  for (const f of ext.functions) {
    if (f.forks) out.push({ level: "deny", rule: "fork-bomb", reason: `function ${f.name} spawns copies of itself`, fix: "Do not run fork bombs." });
  }
  for (const c of ext.commands) out.push(...classifyCommand(c, ext, ctx));
  return withAllTargets(strictest(out, ALLOW), out);
}

/** The winning verdict, carrying every path any command in the call deletes or writes. */
function withAllTargets(v: Verdict, all: Verdict[]): Verdict {
  const targets = [...new Set(all.flatMap((x) => x.targets ?? []))];
  return targets.length ? { ...v, targets } : v;
}

function withTarget(v: Verdict, path: string | undefined): Verdict {
  return path === undefined ? v : { ...v, targets: [path.replaceAll(PLACEHOLDER, "*")] };
}

/** A delete inside the workspace: prompt-free when checkpoints or git can restore it, otherwise the reviewer decides. */
function workspaceDelete(path: string, what: string, ctx: PermissionContext): Verdict {
  const why = ctx.unrecoverable?.(path);
  if (why) return { level: "review", rule: "unrecoverable-delete", reason: `deletes ${what}, which checkpoints can't restore (${why})` };
  return { level: "auto", rule: "workspace-delete", reason: `deletes ${what} inside the workspace` };
}

const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/;

// ---------------------------------------------------------------------------
// Path resolution of words, including the worst case for unset variables.

interface ResolvedArg {
  /** Path with every unknown expansion replaced by an empty string. Undefined if empty or unresolvable. */
  worst?: string;
  /** Exact path when the word is static. */
  exact?: string;
  dynamic: boolean;
  /** Some expansion was unknown and treated as empty for `worst`. Globs alone do not count. */
  unknown: boolean;
  /** Only globs make the word dynamic (`dist/*`). */
  globOnly: boolean;
  /** Names of variables that are not set anywhere, so they expand to nothing. */
  unset: string[];
  /** `${X:?}` with X unset: the shell aborts before running the command. */
  aborts: boolean;
}

function resolveArg(arg: Arg, c: ShellCommand, ext: Extraction, ctx: PermissionContext): ResolvedArg {
  let worst = "";
  let dynamic = false;
  let unknown = false;
  let placeholder = false;
  let glob = false;
  let aborts = false;
  const unset: string[] = [];
  for (const s of arg.segments) {
    switch (s.kind) {
      case "lit":
        worst += s.value;
        break;
      case "var": {
        const known = knownVar(s.name, c, ext, ctx);
        if (known === PLACEHOLDER) { worst += PLACEHOLDER; dynamic = true; placeholder = true; }
        else if (known === "" && s.nonEmpty) {
          if (s.fallback !== undefined) worst += s.fallback;
          else aborts = true;
        } else if (known !== undefined) {
          worst += known;
          if (known === "") unset.push(s.name);
        }
        else if (s.nonEmpty) { worst += PLACEHOLDER; dynamic = true; placeholder = true; }
        else { dynamic = true; unknown = true; }
        break;
      }
      case "cmd":
        dynamic = true;
        if (/^(\$\(\s*pwd\s*\)|`\s*pwd\s*`)$/.test(s.text) && c.cwd !== undefined) worst += c.cwd;
        else if (/^(\$\(|`)\s*mktemp\b/.test(s.text)) { worst += PLACEHOLDER; placeholder = true; }
        else unknown = true;
        break;
      case "glob":
        dynamic = true;
        glob = true;
        worst += s.text;
        break;
      default:
        dynamic = true;
        unknown = true;
    }
  }
  const out: ResolvedArg = { dynamic, unknown, globOnly: glob && !unknown && !placeholder, unset, aborts };
  if (worst !== "") {
    const r = resolvePath(worst, c.cwd, ctx.home);
    if (r !== undefined) out.worst = r;
  }
  if (!dynamic) out.exact = out.worst;
  return out;
}

const NON_EMPTY_SPECIAL = new Set(["$", "!", "?", "0", "-", "RANDOM", "SRANDOM", "PPID", "SECONDS", "LINENO", "BASHPID", "EPOCHSECONDS", "EPOCHREALTIME", "BASH", "BASH_VERSION", "HOSTNAME", "UID", "EUID"]);

/**
 * The value a variable has when the command runs. Pi runs every bash call in a
 * fresh `bash -c`, so a variable is either assigned in the command itself or
 * inherited from the environment Pi passes (`ctx.env`). Anything else is unset.
 * Returns undefined when the value can't be known statically (it comes from
 * `$(...)`, `read`, a loop, or no environment was given).
 */
/** Expands `for` variables over static lists into one word per value. Undefined when there is nothing to expand. */
function variants(arg: Arg, c: ShellCommand, limit = 32): Arg[] | undefined {
  let out: Arg[] = [{ text: arg.text, segments: [] }];
  let expanded = false;
  for (const s of arg.segments) {
    const v = s.kind === "var" ? c.vars.get(s.name) : undefined;
    if (v?.kind === "oneOf" && out.length * v.words.length <= limit) {
      expanded = true;
      out = out.flatMap((o) => v.words.map((w) => ({ text: arg.text, segments: [...o.segments, ...w.segments] })));
    } else out = out.map((o) => ({ text: o.text, segments: [...o.segments, s] }));
  }
  if (!expanded) return undefined;
  return out.map((o) => ({ text: o.text, segments: mergeLiterals(o.segments) }));
}

function mergeLiterals(segments: Arg["segments"]): Arg["segments"] {
  const out: Arg["segments"] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (s.kind === "lit" && last?.kind === "lit") out[out.length - 1] = { kind: "lit", value: last.value + s.value };
    else out.push(s);
  }
  return out;
}

function knownVar(name: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): string | undefined {
  if (name === "PWD") return c.cwd;
  const v = c.vars.get(name);
  if (v?.kind === "literal") return v.value;
  if (v?.kind === "nonEmpty") return PLACEHOLDER;
  if (v?.kind === "unknown" || v?.kind === "oneOf") return undefined;
  if (NON_EMPTY_SPECIAL.has(name)) return PLACEHOLDER;
  if (/^([1-9][0-9]*|@|\*)$/.test(name)) return ""; // `bash -c` gets no positional arguments
  if (name === "#") return "0";
  if (name === "HOME") return ctx.env?.HOME ?? ctx.home;
  if (ctx.env) return ctx.env[name] ?? "";
  if (name === "TMPDIR") return "/tmp";
  return undefined;
}

// ---------------------------------------------------------------------------
// Option parsing helpers.

function values(argv: Arg[]): (string | undefined)[] {
  return argv.map(staticValue);
}

/** Splits arguments into flags and operands. GNU style: flags may follow operands, `--` ends flags. */
function splitArgs(argv: Arg[], withValue: Set<string> = new Set()): { flags: string[]; operands: Arg[] } {
  const flags: string[] = [];
  const operands: Arg[] = [];
  let ended = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    const v = staticValue(a);
    if (!ended && v === "--") { ended = true; continue; }
    if (!ended && v !== undefined && v.startsWith("-") && v !== "-") {
      flags.push(v);
      if (withValue.has(v)) i++;
      continue;
    }
    operands.push(a);
  }
  return { flags, operands };
}

function hasShort(flags: string[], ch: string): boolean {
  return flags.some((f) => !f.startsWith("--") && f.slice(1).includes(ch));
}

function hasLong(flags: string[], ...names: string[]): boolean {
  return flags.some((f) => names.some((n) => f === n || f.startsWith(n + "=")));
}

// ---------------------------------------------------------------------------

const READ_ONLY = new Set([
  "cat", "cd", "cut", "echo", "expr", "false", "grep", "egrep", "fgrep", "head", "id", "ls", "nl", "paste", "pwd", "rev", "seq",
  "stat", "tail", "tr", "true", "uname", "uniq", "wc", "which", "whoami", "diff", "du", "file", "tree", "jq", "printf",
  "basename", "dirname", "realpath", "readlink", "date", "test", "[", ":", "type", "less", "more", "cmp", "md5sum",
  "sha1sum", "sha256sum", "sha512sum", "env", "printenv", "hostname", "df", "free", "uptime", "ps", "pgrep", "mktemp", "sleep",
]);

const SHELL_STATE = new Set(["cd", "pushd", "popd", "export", "local", "declare", "typeset", "readonly", "unset", "set", "shopt", "alias", "unalias", "exit", "return", "shift", "wait", "read", "eval", "trap"]);

const FIND_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-type", "-newer", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-size", "-empty", "-user", "-group", "-perm", "-links", "-inum", "-samefile"]);
const DELETERS = new Set(["rm", "unlink", "shred", "trash", "trash-put", "srm", "rmdir"]);
const DISK_FORMAT = /^(mkfs(\..+)?|wipefs|blkdiscard|mkswap)$/;
const BLOCK_DEVICE = /^\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d|md\d|dm-\d|loop\d|mapper\/)/;
const SAFE_DEVICE = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+|urandom|random)$/;
const POWER = new Set(["shutdown", "reboot", "halt", "poweroff"]);
const DECODERS = /^(base64|base32|basenc|xxd|openssl|uudecode|rev|tr)$/;
const INTERPRETERS = new Set(["python", "python3", "node", "nodejs", "deno", "bun", "perl", "ruby", "php", "lua", "osascript", "Rscript", "pwsh", "powershell"]);
const METADATA = /169\.254\.169\.254|metadata\.google\.internal|fd00:ec2::254|100\.100\.100\.200/i;
const SECRET_VAR = /\$\{?[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?)[A-Za-z0-9_]*\}?/;
const CREDENTIAL_HINT = /(^|\/)(\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.pgpass|\.git-credentials|auth\.json|id_rsa|id_ed25519|\.env)(\/|$|\.|\b)/;

function classifyCommand(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const out: Verdict[] = [];
  out.push(...redirectVerdicts(c, ext, ctx));
  out.push(...scanArgs(c, ext, ctx));

  if (c.opaque) {
    out.push(opaqueVerdict(c));
    return out;
  }
  if (c.argv.length === 0) {
    if (c.privileged) out.push({ level: "ask", rule: "privileged-shell", reason: `${c.wrappers[0]} opens a root shell whose commands can't be checked` });
    else if (c.wrappers.at(-1) === "env") out.push({ level: "review", rule: "env-dump", reason: "prints the environment, which may hold secrets" });
    return out;
  }

  const head = headName(c.argv[0]);
  if (head === undefined) {
    out.push({ level: "ask", rule: "dynamic-command", reason: `the command name comes from an expansion whose value isn't known: ${c.argv[0]!.text}` });
    return out;
  }
  if (c.privileged) out.push(privilegeVerdict(head, c));

  out.push(...byHead(head, c, ext, ctx));
  return out;
}

/**
 * sudo and friends go to the reviewer, which judges the command they run; the
 * rules still check that command (`sudo rm -rf /` stays denied). A root shell
 * reading commands we can't see (`sudo -i`, `su`, `curl ... | sudo bash`) asks.
 */
function privilegeVerdict(head: string, c: ShellCommand): Verdict {
  const v = values(c.argv);
  const rootShell =
    (head === "su" && !v.some((x) => x === "-c" || x === "--command")) ||
    ((SHELLS.has(head) || INTERPRETERS.has(head)) && !v.slice(1).some((x) => x !== undefined && (/^-[a-zA-Z]*[ce]$/.test(x) || x === "--eval" || x === "--command")) &&
      v.slice(1).every((x) => x === undefined || x.startsWith("-")));
  if (rootShell) return { level: "ask", rule: "privileged-shell", reason: `${c.wrappers.join(" ")} ${head} runs a root shell whose commands can't be checked` };
  return { level: "review", rule: "privilege", reason: `runs ${head} with elevated privileges (${c.wrappers.join(" ")})` };
}

function byHead(head: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const argv = c.argv;
  const v = values(argv);

  if (DELETERS.has(head)) return deleteVerdicts(head, c, ext, ctx);
  if (head === "find") return findVerdicts(c, ext, ctx);
  if (DISK_FORMAT.test(head)) return [{ level: "deny", rule: "disk-format", reason: `${head} formats or wipes a disk`, fix: "Do not format disks from the agent." }];
  if (head === "dd") return ddVerdicts(c, ext, ctx);
  if (POWER.has(head)) return [{ level: "deny", rule: "power", reason: `${head} shuts down or restarts the machine`, fix: "Ask the user to do this themselves." }];
  if ((head === "init" || head === "telinit") && (v[1] === "0" || v[1] === "6")) return [{ level: "deny", rule: "power", reason: `${head} ${v[1]} shuts down or restarts the machine` }];
  if ((head === "systemctl" || head === "loginctl") && v.slice(1).some((x) => x === "poweroff" || x === "reboot" || x === "halt" || x === "kexec")) {
    return [{ level: "deny", rule: "power", reason: `${head} shuts down or restarts the machine` }];
  }
  if (head === "kill") return killVerdicts(c);
  if (head === "chmod" || head === "chown" || head === "chgrp") return permissionVerdicts(head, c, ext, ctx);
  if (AGENTS[head]) {
    const bad = AGENTS[head]!(v.slice(1));
    if (bad) return [{ level: "deny", rule: "agent-without-approvals", reason: `starts ${head} with approvals turned off (${bad})`, fix: "Start subagents through b4agent's agent tool instead." }];
  }
  const publish = publishVerdict(head, v);
  if (publish) return [publish];
  const infra = infraVerdict(head, v);
  if (infra) return [infra];
  if (head === "git") return gitVerdicts(c, ext, ctx);

  if (SHELLS.has(head) || INTERPRETERS.has(head)) return interpreterVerdicts(head, c, ext);
  if (head === "curl" || head === "wget") return networkVerdicts(head, c, ext, ctx);
  if (head === "source" || head === ".") return [{ level: "review", rule: "source", reason: "runs a script file in the current shell" }];
  if (SHELL_STATE.has(head)) return [ALLOW];
  if (head === "sed") return sedVerdicts(c, ext, ctx);
  if (head === "rg") return hasLong(splitArgs(argv).flags, "--pre", "--hostname-bin") ? [{ level: "review", rule: "rg-pre", reason: "rg --pre runs a program on every file" }] : [readVerdict()];
  if (head === "sort") return writesOption(c, ext, ctx, ["-o", "--output"]) ?? [readVerdict()];
  if (head === "tree") return writesOption(c, ext, ctx, ["-o"]) ?? [readVerdict()];
  if (head === "fd" || head === "fdfind") return [readVerdict()]; // -x commands are checked as nested commands
  if (head === "xargs") return [ALLOW]; // the command xargs runs is checked on its own
  if (READ_ONLY.has(head)) return [readVerdict()];
  if (FILE_WRITERS[head]) return fileWriteVerdicts(head, c, ext, ctx);
  const routine = routineVerdict(head, v);
  if (routine) return [routine];
  return [{ level: "review", rule: "unrecognized", reason: `${head} is not on the known-safe list` }];
}

function readVerdict(): Verdict {
  return { level: "allow", rule: "read-only", reason: "read-only command" };
}

// --- deletes -----------------------------------------------------------------

function deleteVerdicts(head: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const { flags, operands } = splitArgs(c.argv);
  if (hasLong(flags, "--no-preserve-root")) {
    return [{ level: "deny", rule: "no-preserve-root", reason: `${head} --no-preserve-root`, fix: "Never pass --no-preserve-root." }];
  }
  const recursive = head === "rm" && (hasShort(flags, "r") || hasShort(flags, "R") || hasLong(flags, "--recursive"));
  if (head === "shred") {
    for (const o of operands) {
      const r = resolveArg(o, c, ext, ctx);
      if (r.worst && BLOCK_DEVICE.test(r.worst)) return [{ level: "deny", rule: "disk-wipe", reason: `shred on a block device: ${r.worst}` }];
    }
  }
  if (operands.length === 0) return [ALLOW];
  return operands.map((o) => deleteTarget(head, o, recursive, c, ext, ctx));
}

function deleteTarget(head: string, o: Arg, recursive: boolean, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict {
  const vs = variants(o, c);
  if (vs) {
    const all = vs.map((v) => deleteTarget(head, v, recursive, c, ext, ctx));
    return withAllTargets(strictest(all, ALLOW), all);
  }
  const r = resolveArg(o, c, ext, ctx);
  return withTarget(deleteResolved(head, o, recursive, r, ctx), r.worst);
}

function deleteResolved(head: string, o: Arg, recursive: boolean, r: ResolvedArg, ctx: PermissionContext): Verdict {
  if (r.aborts) return { level: "allow", rule: "aborts-unset", reason: `${o.text}: the variable is unset, so the shell stops before ${head} runs` };
  if (!r.dynamic && r.worst === undefined) return { level: "allow", rule: "empty-operand", reason: `${o.text} expands to nothing` };
  if (recursive && r.worst && isCriticalPath(r.worst, ctx)) {
    if (r.unset.length) {
      return {
        level: "deny", rule: "unguarded-variable-delete",
        reason: `${head} -r ${o.text}: ${r.unset.map((n) => "$" + n).join(", ")} expands to nothing (unset or empty), so this deletes ${r.worst}`,
        fix: "Set the variable in the command, guard it with ${VAR:?}, or use a literal path.",
      };
    }
    if (r.unknown) {
      return {
        level: "deny", rule: "unguarded-variable-delete",
        reason: `${head} -r ${o.text}: if a variable in it is empty or unset this deletes ${r.worst.replaceAll(PLACEHOLDER, "*")}`,
        fix: "Guard the variable with ${VAR:?} or use a literal path.",
      };
    }
    return { level: "deny", rule: "critical-path-delete", reason: `${head} -r on a critical path: ${r.worst}`, fix: "Name the specific directory to delete instead." };
  }
  if (r.globOnly && r.worst) {
    // Only globs: judge by the directory the glob expands in (`rm -rf dist/*`).
    const dir = r.worst.split("/").filter((_, i, parts) => !parts.slice(0, i + 1).some((p) => /[*?[]/.test(p))).join("/") || "/";
    const w = classifyWrite(dir, ctx, "delete");
    if (w.rule === "workspace-write") return workspaceDelete(r.worst, o.text, ctx);
    if (w.level === "allow" || w.level === "ask" || w.level === "deny") return w;
  }
  if (r.dynamic) return { level: "review", rule: "dynamic-delete", reason: `${head} with a target that depends on expansions: ${o.text}` };
  if (r.exact === undefined) return { level: "review", rule: "unresolved-delete", reason: `${head} ${o.text} in an unknown directory` };
  if (isCriticalPath(r.exact, ctx)) return { level: "review", rule: "critical-path", reason: `${head} on ${r.exact}` };
  const w = classifyWrite(r.exact, ctx, "delete");
  if (w.rule === "workspace-write") return workspaceDelete(r.exact, posix.relative(ctx.workspace, r.exact) || ".", ctx);
  return w;
}

function findVerdicts(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const v = values(c.argv);
  let i = 1;
  const starts: Arg[] = [];
  for (; i < c.argv.length; i++) {
    const x = v[i];
    if (x !== undefined && (x.startsWith("-") || x === "(" || x === "!" || x === ")")) break;
    starts.push(c.argv[i]!);
  }
  const rest = v.slice(i);
  const execs: string[] = [];
  rest.forEach((x, k) => {
    if (x === "-exec" || x === "-execdir" || x === "-ok" || x === "-okdir") execs.push(headName(c.argv[i + k + 1]) ?? "?");
  });
  const deleting = rest.includes("-delete") || execs.some((h) => DELETERS.has(h));
  // With a filter (`-name '*.tmp'`) find deletes matches, not the whole tree.
  const filtered = rest.some((x) => x !== undefined && FIND_FILTERS.has(x));
  const out: Verdict[] = [];
  if (deleting) {
    const targets = starts.length ? starts : [{ text: ".", segments: [{ kind: "lit" as const, value: "." }] }];
    for (const t of targets) {
      if (!filtered) { out.push(deleteTarget("find -delete", t, true, c, ext, ctx)); continue; }
      const w = writeTarget(t, c, ext, ctx, "find -delete");
      const start = w.targets?.[0];
      if (w.rule !== "workspace-write" || !start) { out.push(w); continue; }
      // `-name x` narrows what can't be restored to the matches: `start/**/x`.
      const names = rest.flatMap((x, k) => (x === "-name" || x === "-iname" ? [rest[k + 1]] : []));
      const scope = names.length === 1 && names[0] !== undefined ? posix.join(start, "**", names[0]) : start;
      out.push({ ...workspaceDelete(scope, `files matched by find under ${t.text}`, ctx), targets: [scope] });
    }
  }
  for (const opt of ["-fprint", "-fprint0", "-fprintf", "-fls"]) {
    const k = rest.indexOf(opt);
    if (k >= 0) out.push(writeTarget(c.argv[i + k + 1], c, ext, ctx, "find " + opt));
  }
  if (!out.length) out.push(readVerdict());
  return out;
}

// --- disks, power, processes, permissions ------------------------------------

function ddVerdicts(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const out: Verdict[] = [];
  for (const a of c.argv.slice(1)) {
    const s = staticValue(a);
    const m = /^(if|of)=(.*)$/.exec(s ?? a.text);
    if (!m) continue;
    const p = resolvePath(m[2]!, c.cwd, ctx.home);
    if (m[1] === "of") {
      if (p && BLOCK_DEVICE.test(p)) return [{ level: "deny", rule: "raw-device-write", reason: `dd writes to a block device: ${p}`, fix: "Do not write raw devices from the agent." }];
      out.push(p && s !== undefined ? (SAFE_DEVICE.test(p) ? ALLOW : classifyWrite(p, ctx, "dd write")) : { level: "review", rule: "dd", reason: "dd with a dynamic output" });
    } else if (p && s !== undefined) out.push(classifyRead(p, ctx));
  }
  return out.length ? out : [{ level: "review", rule: "dd", reason: "dd" }];
}

function killVerdicts(c: ShellCommand): Verdict[] {
  const v = values(c.argv).slice(1);
  let i = 0;
  if (v[0] === "-l" || v[0] === "-L") return [ALLOW];
  if (v[0] === "-s" || v[0] === "-n") i = 2;
  // A leading `-N` / `-SIG` is the signal when something follows it: `kill -1 123` sends SIGHUP.
  else if (v[0] !== undefined && v[0] !== "--" && /^-[A-Za-z0-9]+$/.test(v[0]) && v.length > 1) i = 1;
  if (v[i] === "--") i++;
  const pids = v.slice(i);
  if (pids.includes("-1") || pids.includes("1")) return [{ level: "deny", rule: "kill-all", reason: "kills every process (pid -1) or init (pid 1)" }];
  return [{ level: "review", rule: "kill", reason: "sends a signal to a process" }];
}

function permissionVerdicts(head: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const { flags, operands } = splitArgs(c.argv, new Set(["--reference"]));
  const recursive = hasShort(flags, "R") || hasLong(flags, "--recursive");
  const targets = operands.slice(1); // first operand is the mode or owner
  const out: Verdict[] = [];
  for (const t of targets) {
    const r = resolveArg(t, c, ext, ctx);
    if (recursive && r.worst && isCriticalPath(r.worst, ctx)) {
      return [{ level: "deny", rule: "recursive-permission-change", reason: `${head} -R on a critical path: ${r.worst}`, fix: "Change permissions on the specific files instead." }];
    }
    out.push(writeTarget(t, c, ext, ctx, head));
  }
  return out.length ? out : [{ level: "review", rule: head, reason: head }];
}

// --- agents, publishing, infrastructure --------------------------------------

const has = (args: (string | undefined)[], ...xs: string[]) => args.some((a) => a !== undefined && xs.some((x) => a === x || a.startsWith(x + "=")));

const AGENTS: Record<string, (args: (string | undefined)[]) => string | undefined> = {
  claude: (a) => has(a, "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions") ? "--dangerously-skip-permissions" : a.some((x, i) => x === "--permission-mode" && a[i + 1] === "bypassPermissions") || has(a, "--permission-mode=bypassPermissions") ? "--permission-mode bypassPermissions" : undefined,
  codex: (a) => has(a, "--dangerously-bypass-approvals-and-sandbox", "--yolo") ? "--dangerously-bypass-approvals-and-sandbox" : undefined,
  gemini: (a) => has(a, "--yolo", "-y") || a.some((x, i) => x === "--approval-mode" && a[i + 1] === "yolo") ? "--yolo" : undefined,
  droid: (a) => has(a, "--skip-permissions-unsafe") ? "--skip-permissions-unsafe" : undefined,
  amp: (a) => has(a, "--dangerously-allow-all") ? "--dangerously-allow-all" : undefined,
  b4agent: (a) => has(a, "--yolo") || a.some((x, i) => x === "--mode" && a[i + 1] === "yolo") ? "--yolo" : undefined,
};

function publishVerdict(head: string, v: (string | undefined)[]): Verdict | undefined {
  const sub = v[1];
  const pub = (what: string): Verdict => ({ level: "ask", rule: "publish", reason: `publishes: ${what}` });
  if (["npm", "pnpm", "bun"].includes(head) && sub === "publish") return pub(`${head} publish`);
  if (head === "yarn" && (sub === "publish" || (sub === "npm" && v[2] === "publish"))) return pub("yarn publish");
  if (head === "cargo" && sub === "publish") return pub("cargo publish");
  if (head === "twine" && sub === "upload") return pub("twine upload");
  if (head === "gem" && sub === "push") return pub("gem push");
  if ((head === "docker" || head === "podman") && (sub === "push" || (sub === "image" && v[2] === "push"))) return pub(`${head} push`);
  if (head === "gh" && sub === "release" && v[2] === "create") return pub("gh release create");
  if ((head === "poetry" || head === "uv" || head === "vsce" || head === "ovsx") && sub === "publish") return pub(`${head} publish`);
  return undefined;
}

function infraVerdict(head: string, v: (string | undefined)[]): Verdict | undefined {
  const destroy = (what: string): Verdict => ({ level: "ask", rule: "infra-destroy", reason: `destroys infrastructure: ${what}` });
  if (["terraform", "tofu", "pulumi", "cdk", "cdktf", "terragrunt"].includes(head)) {
    if (v.includes("destroy")) return destroy(`${head} destroy`);
    if (v.includes("apply") && v.some((x) => x === "-destroy" || x === "--destroy")) return destroy(`${head} apply -destroy`);
  }
  if (head === "kubectl" || head === "oc") {
    const sub = v.find((x, i) => i > 0 && x !== undefined && !x.startsWith("-"));
    if (sub === "drain") return destroy(`${head} drain`);
    if (sub === "delete" && (v.some((x) => x === "ns" || x === "namespace" || x === "namespaces" || (x ?? "").startsWith("namespace/") || (x ?? "").startsWith("ns/")) || v.includes("--all") || v.includes("-A") || v.includes("--all-namespaces"))) {
      return destroy(`${head} delete (namespace or --all)`);
    }
  }
  if (head === "helm" && ["uninstall", "delete", "del", "un"].includes(v[1] ?? "")) return destroy("helm uninstall");
  return undefined;
}

// --- git ---------------------------------------------------------------------

const PROTECTED_BRANCH = /^(main|master|trunk|develop|release.*|prod.*|production)$/;
const GIT_READ = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "cat-file", "blame", "describe", "shortlog", "grep", "whatchanged", "count-objects", "merge-base", "name-rev", "for-each-ref", "show-ref", "help", "version", "var", "check-ignore", "range-diff"]);

/** Index of git's subcommand, after global options. */
function gitSubcommandIndex(v: (string | undefined)[]): number {
  let i = 1;
  for (; i < v.length; i++) {
    const x = v[i];
    if (x === undefined) break;
    if (x === "-C" || x === "--git-dir" || x === "--work-tree" || x === "--namespace" || x === "--exec-path" || x === "-c" || x === "--config-env") { i++; continue; }
    if (x.startsWith("-")) continue;
    break;
  }
  return i;
}

function gitVerdicts(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const v = values(c.argv);
  const i = gitSubcommandIndex(v);
  const configOverride = v.slice(1, i).some((x) => x === "-c" || x === "--config-env" || (x ?? "").startsWith("--exec-path="));
  const sub = v[i];
  const args = v.slice(i + 1);
  const out: Verdict[] = [];
  if (configOverride) out.push({ level: "review", rule: "git-config-override", reason: "git -c can set options that run programs" });
  const review = (what: string): Verdict => ({ level: "review", rule: "git-destructive", reason: `git ${what} discards work or rewrites history` });
  const auto = (what: string): Verdict => ({ level: "auto", rule: "git-routine", reason: `git ${what}` });
  const read: Verdict = { level: "allow", rule: "git-read", reason: `git ${sub ?? ""} is read-only` };

  if (sub === undefined) return [...out, { level: "review", rule: "git", reason: "git with a dynamic subcommand" }];
  if (GIT_READ.has(sub)) {
    if (args.some((a) => a !== undefined && (a === "--output" || a.startsWith("--output=") || a === "--ext-diff"))) out.push({ level: "review", rule: "git-output", reason: `git ${sub} writes a file or runs an external diff` });
    else out.push(read);
    return out;
  }
  switch (sub) {
    case "branch": {
      if (args.some((a) => a === "-D" || ((a === "-d" || a === "--delete") && args.some((b) => b === "-f" || b === "--force")))) out.push(review("branch -D"));
      else if (args.some((a) => a !== undefined && /^(-[dmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/.test(a))) out.push(auto("branch " + args.join(" ")));
      else if (args.some((a) => a !== undefined && !a.startsWith("-"))) out.push(auto("branch (create)"));
      else out.push(read);
      return out;
    }
    case "tag":
      out.push(args.length === 0 || args.some((a) => a === "-l" || a === "--list") ? read : args.some((a) => a === "-d" || a === "--delete") ? review("tag -d") : auto("tag"));
      return out;
    case "stash": {
      const s = args.find((a) => a !== undefined && !a.startsWith("-"));
      if (s === "list" || s === "show") out.push(read);
      else if (s === "drop" || s === "clear") out.push(review("stash " + s));
      else out.push(auto("stash"));
      return out;
    }
    case "remote":
      out.push(args.length === 0 || args.every((a) => a === "-v" || a === "--verbose") || args[0] === "show" || args[0] === "get-url" ? read : { level: "review", rule: "git-remote", reason: "changes git remotes" });
      return out;
    case "config":
      out.push(args.some((a) => a !== undefined && /^(--get|--get-all|--get-regexp|--list|-l|--show-origin)/.test(a)) || args[0] === "get" || args[0] === "list" ? read : { level: "review", rule: "git-config", reason: "changes git config" });
      return out;
    case "reflog":
      out.push(args[0] === "expire" || args[0] === "delete" ? review("reflog " + args[0]) : read);
      return out;
    case "worktree":
      out.push(args[0] === "list" ? read : args[0] === "add" ? auto("worktree add") : { level: "review", rule: "git-worktree", reason: `git worktree ${args[0] ?? ""}` });
      return out;
    case "add": case "mv": case "init": case "apply": case "fetch":
      out.push(auto(sub));
      return out;
    case "rm":
      out.push(auto("rm"));
      return out;
    case "commit":
      out.push(args.includes("--amend") ? { level: "review", rule: "git-amend", reason: "git commit --amend rewrites the last commit" } : auto("commit"));
      return out;
    case "switch":
      out.push(args.some((a) => a === "--discard-changes" || a === "-f" || a === "--force") ? review("switch --discard-changes") : auto("switch"));
      return out;
    case "checkout": {
      const dd = args.indexOf("--");
      if (args.some((a) => a === "-f" || a === "--force") || (dd >= 0 && args.length > dd + 1) || args.includes(".")) out.push(review("checkout (discards changes)"));
      else out.push(auto("checkout"));
      return out;
    }
    case "restore":
      out.push(args.some((a) => a === "--staged" || a === "-S") && !args.some((a) => a === "--worktree" || a === "-W") ? auto("restore --staged") : review("restore"));
      return out;
    case "reset":
      out.push(args.some((a) => a === "--hard" || a === "--merge" || a === "--keep") ? review("reset --hard") : auto("reset"));
      return out;
    case "clean":
      out.push(args.some((a) => a !== undefined && (a === "--force" || /^-[a-zA-Z]*f/.test(a))) && !args.some((a) => a === "-n" || a === "--dry-run") ? review("clean -f") : read);
      return out;
    case "gc": case "prune": case "filter-branch": case "filter-repo": case "update-ref":
      out.push(sub === "gc" && !args.some((a) => (a ?? "").startsWith("--prune")) ? auto("gc") : review(sub));
      return out;
    case "push":
      out.push(pushVerdict(args, ctx));
      return out;
    default:
      out.push({ level: "review", rule: "git", reason: `git ${sub}` });
      return out;
  }
}

function pushVerdict(args: (string | undefined)[], ctx: PermissionContext): Verdict {
  const flags = args.filter((a) => a !== undefined && a.startsWith("-")) as string[];
  const operands = args.filter((a) => a === undefined || !a.startsWith("-"));
  if (flags.includes("--mirror")) return { level: "ask", rule: "force-push-protected", reason: "git push --mirror overwrites every remote ref" };
  if (flags.some((f) => f === "--delete" || f === "-d")) return { level: "review", rule: "git-push-delete", reason: "deletes a remote branch" };
  const refspecs = operands.slice(1);
  const force = flags.some((f) => f === "-f" || f === "--force" || f.startsWith("--force-with-lease") || f === "--force-if-includes" || (/^-[a-zA-Z]+$/.test(f) && f.includes("f"))) || refspecs.some((r) => r?.startsWith("+"));
  if (!force) return { level: "review", rule: "git-push", reason: "pushes to a remote" };
  const dests = refspecs.length
    ? refspecs.map((r) => (r === undefined ? undefined : (r.replace(/^\+/, "").split(":").pop() ?? "").replace(/^refs\/heads\//, "")))
    : [ctx.currentBranch];
  if (dests.some((d) => d === undefined || d === "" || d === "HEAD" || PROTECTED_BRANCH.test(d))) {
    return { level: "ask", rule: "force-push-protected", reason: `force push to ${dests.map((d) => d ?? "an unknown branch").join(", ")}` };
  }
  return { level: "review", rule: "force-push", reason: `force push to ${dests.join(", ")}` };
}

// --- shells, interpreters, network ------------------------------------------

function interpreterVerdicts(head: string, c: ShellCommand, ext: Extraction): Verdict[] {
  const v = values(c.argv);
  const inline = v.slice(1).some((x) => x !== undefined && (/^-[a-zA-Z]*[ce]$/.test(x) || x === "--eval" || x === "--command"));
  if (SHELLS.has(head) && inline) return [ALLOW]; // the script itself was parsed and checked
  const operand = v.slice(1).find((x) => x === undefined || !x.startsWith("-"));
  const readsStdin = operand === undefined || operand === "-";
  if (readsStdin && c.pipe && c.pipe.index > 0) {
    const upstream = ext.commands.filter((o) => o.pipe?.id === c.pipe!.id && o.pipe.index < c.pipe!.index && o.depth === c.depth);
    if (upstream.some((u) => isDecoder(u))) return [{ level: "ask", rule: "obfuscated-exec", reason: `decoded data piped into ${head}` }];
    return [{ level: "review", rule: "pipe-to-shell", reason: `output piped into ${head}` }];
  }
  if (inline) return [{ level: "review", rule: "inline-code", reason: `${head} runs inline code` }];
  if (readsStdin && c.redirects.some((r) => r.input !== undefined)) return [ALLOW]; // heredoc body was parsed
  return [{ level: "review", rule: "run-script", reason: `${head} runs ${operand ?? "a script"}` }];
}

function isDecoder(c: ShellCommand): boolean {
  const h = headName(c.argv[0]);
  if (!h || !DECODERS.test(h)) return false;
  const v = values(c.argv);
  if (h === "base64" || h === "base32" || h === "basenc") return v.some((x) => x === "-d" || x === "--decode" || x === "-D" || (x !== undefined && /^-[a-zA-Z]*d/.test(x) && !x.startsWith("--")));
  if (h === "xxd") return v.some((x) => x !== undefined && /^-[a-zA-Z]*r/.test(x));
  if (h === "openssl") return v.some((x) => x === "-d" || x === "-base64" || x === "base64");
  return true;
}

function networkVerdicts(head: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const upload = head === "curl"
    ? new Set(["-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "-T", "--upload-file", "--json"])
    : new Set(["--post-file", "--post-data", "--body-file", "--body-data"]);
  const argv = c.argv;
  for (let i = 1; i < argv.length; i++) {
    const flag = staticValue(argv[i]!);
    if (flag === undefined) continue;
    let value: Arg | undefined;
    const eq = flag.indexOf("=");
    if (eq > 0 && upload.has(flag.slice(0, eq))) value = { text: flag.slice(eq + 1), segments: [{ kind: "lit", value: flag.slice(eq + 1) }] };
    else if (upload.has(flag)) value = argv[i + 1];
    if (!value) continue;
    if (SECRET_VAR.test(value.text)) return [{ level: "ask", rule: "secret-upload", reason: `${head} uploads data containing a secret variable: ${value.text}` }];
    const s = staticValue(value);
    const file = s?.replace(/^[a-zA-Z0-9_-]+=/, "").replace(/^</, "");
    if (file?.startsWith("@") || head === "wget" || flag === "-T" || flag === "--upload-file") {
      const p = resolvePath(file!.replace(/^@/, ""), c.cwd, ctx.home);
      if (p && isCredentialPath(p, ctx)) return [{ level: "ask", rule: "secret-upload", reason: `${head} uploads a credential file: ${p}` }];
    }
  }
  return [{ level: "review", rule: "network", reason: `${head} makes a network request` }];
}

function opaqueVerdict(c: ShellCommand): Verdict {
  const text = c.opaque?.payload?.text ?? "";
  if (/\b(base64|base32|basenc)\b[^|)]*\s-(d|-decode|D)\b|\bxxd\b[^|)]*\s-r|\bopenssl\b[^|)]*\s-d\b/.test(text)) {
    return { level: "ask", rule: "obfuscated-exec", reason: `${c.opaque!.via} runs decoded data` };
  }
  if (c.opaque!.via === "eval" && /\b(curl|wget|fetch|nc|ncat)\b/.test(text)) {
    return { level: "ask", rule: "eval-download", reason: "eval runs downloaded code" };
  }
  return { level: "review", rule: "opaque-script", reason: `${c.opaque!.via} runs a script built at run time: ${text}` };
}

// --- files -------------------------------------------------------------------

const FILE_WRITERS: Record<string, true> = { mkdir: true, touch: true, cp: true, mv: true, ln: true, tee: true, truncate: true, install: true, rsync: true };

function fileWriteVerdicts(head: string, c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const withValue = head === "truncate" ? new Set(["-s", "--size", "-r", "--reference"]) : head === "install" ? new Set(["-m", "-o", "-g", "-t", "-S"]) : new Set(["-t", "--target-directory", "-S", "--suffix"]);
  const { flags, operands } = splitArgs(c.argv, withValue);
  if (head === "rsync") {
    if (operands.some((o) => /^[^/]*:/.test(o.text)) || flags.some((f) => f.startsWith("--delete") || f === "--remove-source-files")) {
      return [{ level: "review", rule: "rsync", reason: "rsync to a remote or with deletion" }];
    }
  }
  let targets: Arg[];
  const tIndex = c.argv.findIndex((a) => ["-t", "--target-directory"].includes(staticValue(a) ?? ""));
  if (tIndex > 0 && (head === "cp" || head === "mv" || head === "ln" || head === "install")) targets = [c.argv[tIndex + 1]!].filter(Boolean);
  else if (head === "cp" || head === "mv" || head === "ln" || head === "install" || head === "rsync") targets = operands.slice(-1);
  else targets = operands;
  const out = targets.map((t) => writeTarget(t, c, ext, ctx, head));
  if (head === "mv") for (const s of operands.slice(0, -1)) out.push(writeTarget(s, c, ext, ctx, "mv (source)"));
  return out.length ? out : [ALLOW];
}

function sedVerdicts(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const { flags, operands } = splitArgs(c.argv, new Set(["-e", "--expression", "-f", "--file", "-l", "--line-length"]));
  const inPlace = flags.some((f) => f === "-i" || f.startsWith("--in-place") || (/^-[a-zA-Z]+$/.test(f) && f.includes("i")));
  const explicitScript = flags.some((f) => f === "-e" || f === "--expression" || f === "-f" || f === "--file" || f.startsWith("--expression=") || f.startsWith("--file="));
  const scripts = explicitScript ? [] : operands.slice(0, 1);
  const files = explicitScript ? operands : operands.slice(1);
  // GNU sed `e` runs a command and `w` writes a file.
  if (scripts.some((s) => /(^|[;\n}])\s*[0-9,$]*\s*[ew]\b|\/[ew]\s*$|s(.).*\1.*\1[gpI0-9]*[ew]/.test(staticValue(s) ?? s.text))) {
    return [{ level: "review", rule: "sed-exec", reason: "sed script runs commands or writes files" }];
  }
  if (!inPlace) return [readVerdict()];
  return files.length ? files.map((f) => writeTarget(f, c, ext, ctx, "sed -i")) : [readVerdict()];
}

function writesOption(c: ShellCommand, ext: Extraction, ctx: PermissionContext, opts: string[]): Verdict[] | undefined {
  for (let i = 1; i < c.argv.length; i++) {
    const v = staticValue(c.argv[i]!);
    if (v === undefined) continue;
    if (opts.includes(v)) return [writeTarget(c.argv[i + 1], c, ext, ctx, `${headName(c.argv[0])} ${v}`)];
    const eq = opts.find((o) => o.startsWith("--") && v.startsWith(o + "="));
    if (eq) return [writeTarget({ text: v.slice(eq.length + 1), segments: [{ kind: "lit", value: v.slice(eq.length + 1) }] }, c, ext, ctx, eq)];
  }
  return undefined;
}

function writeTarget(t: Arg | undefined, c: ShellCommand, ext: Extraction, ctx: PermissionContext, what: string): Verdict {
  if (!t) return { level: "review", rule: "write", reason: what };
  const vs = variants(t, c);
  if (vs) {
    const all = vs.map((v) => writeTarget(v, c, ext, ctx, what));
    return withAllTargets(strictest(all, ALLOW), all);
  }
  const r = resolveArg(t, c, ext, ctx);
  const v = writeResolved(t, r, ctx, what);
  return v === ALLOW ? v : withTarget(v, r.worst);
}

function writeResolved(t: Arg, r: ResolvedArg, ctx: PermissionContext, what: string): Verdict {
  if (r.aborts || (!r.dynamic && r.worst === undefined)) return ALLOW; // the shell fails before writing
  if (r.exact === undefined) {
    if (r.worst && isOwnGuardPath(r.worst, ctx)) return classifyWrite(r.worst, ctx, what);
    return { level: "review", rule: "dynamic-write", reason: `${what} to a path that depends on expansions: ${t.text}` };
  }
  if (r.exact.startsWith("/dev/")) {
    if (SAFE_DEVICE.test(r.exact)) return ALLOW;
    if (BLOCK_DEVICE.test(r.exact)) return { level: "deny", rule: "raw-device-write", reason: `${what} to a block device: ${r.exact}`, fix: "Do not write raw devices from the agent." };
    return { level: "review", rule: "device-write", reason: `${what} to ${r.exact}` };
  }
  return classifyWrite(r.exact, ctx, what);
}

function redirectVerdicts(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const out: Verdict[] = [];
  for (const r of c.redirects) {
    if (!r.target) continue;
    const fdDup = (r.op === ">&" || r.op === "<&") && /^(\d+|-)$/.test(staticValue(r.target) ?? "");
    if (fdDup) continue;
    if (r.op === "<") {
      const p = resolveArg(r.target, c, ext, ctx);
      if (p.exact) out.push(classifyRead(p.exact, ctx));
      continue;
    }
    out.push(writeTarget(r.target, c, ext, ctx, `redirect ${r.op}`));
  }
  return out;
}

/** Checks every word for credential files, cloud metadata endpoints and the guard's own files. */
function scanArgs(c: ShellCommand, ext: Extraction, ctx: PermissionContext): Verdict[] {
  const out: Verdict[] = [];
  const head = headName(c.argv[0]);
  const readOnly = head !== undefined && (READ_ONLY.has(head) || head === "git" || head === "rg" || head === "find");
  const credential = (what: string): Verdict =>
    onlyMetadata(c, ext)
      ? { level: "review", rule: "credential-metadata", reason: `${head} lists or names a credential file without reading it: ${what}` }
      : { level: "ask", rule: "credentials", reason: `${head ?? "command"} touches a credential file: ${what}` };
  for (const word of c.argv.slice(1)) {
    if (METADATA.test(word.text)) out.push({ level: "ask", rule: "cloud-metadata", reason: `reaches a cloud metadata endpoint: ${word.text}` });
    // `for f in ~/.ssh/*` and `F=~/.ssh/id_rsa` are checked by the values they take.
    for (const a of variants(word, c) ?? [word]) {
      const s = staticValue(a) ?? (isDynamic(a) ? knownPath(a, c, ext, ctx) : undefined);
      // `git show HEAD:.env` names the file after the revision.
      const candidate = s?.replace(/^-{1,2}[A-Za-z-]+=/, "").replace(/^@/, "").replace(head === "git" ? /^[^/:]*:(?!\/\/)/ : /^$/, "");
      if (candidate !== undefined && /[/~.]/.test(candidate) && !/^[a-z]+:\/\//i.test(candidate)) {
        const p = resolvePath(candidate, c.cwd, ctx.home);
        if (p && isCredentialPath(p, ctx)) out.push(credential(p));
        if (p && !readOnly && isOwnGuardPath(p, ctx)) out.push(classifyWrite(p, ctx, head ?? "command"));
      } else if (isDynamic(a) && CREDENTIAL_HINT.test(argText(a))) {
        out.push(credential(argText(a)));
      }
    }
  }
  return out;
}

/** The value of a word built only from variables the gate can resolve. */
function knownPath(a: Arg, c: ShellCommand, ext: Extraction, ctx: PermissionContext): string | undefined {
  const r = resolveArg(a, c, ext, ctx);
  return r.dynamic ? undefined : r.worst;
}

function argText(a: Arg): string {
  return a.segments.map((s) => (s.kind === "lit" ? s.value : s.text)).join("");
}

/** Commands that look at a file's name, type or size but never print what's in it. */
const METADATA_ONLY = new Set(["ls", "stat", "file", "test", "[", "du", "realpath", "readlink", "basename", "dirname", "tree", "find", "fd", "fdfind"]);
/** git subcommands that only name a path. `git log -p`, `diff` and `show` print contents, so they don't count. */
const GIT_NAMES_ONLY = new Set(["check-ignore", "ls-files", "status"]);
/** Commands later in a pipeline that only filter the listing (`ls ~/.ssh | grep id`). */
const LISTING_FILTERS = new Set(["grep", "egrep", "fgrep", "rg", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "column", "nl", "less", "more", "cat"]);

/**
 * Listing or stat-ing a credential store, or naming one to git, reveals no
 * secret, so the reviewer can clear it. Not when the names feed something that
 * could open the files (`ls ~/.ssh | xargs cat`, `find ~/.ssh -exec cat {} +`).
 */
function onlyMetadata(c: ShellCommand, ext: Extraction): boolean {
  const head = headName(c.argv[0]);
  if (head === undefined) return false;
  const v = values(c.argv);
  if (head === "git") {
    const i = gitSubcommandIndex(v);
    const patch = v.some((x) => x === undefined || /^(-p|-u|--patch|-L.*|--word-diff.*|--full-diff)$/.test(x));
    if (!GIT_NAMES_ONLY.has(v[i] ?? "") && !(v[i] === "rm" && v.includes("--cached")) && !(v[i] === "log" && !patch)) return false;
  } else if (!METADATA_ONLY.has(head)) return false;
  if ((head === "find" || head === "fd" || head === "fdfind") && v.some((x) => x === undefined || /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls|x|X)$|^--exec/.test(x))) return false;
  if (head === "tree" && v.includes("-o")) return false;
  if (!c.pipe) return true;
  const { id, index } = c.pipe;
  return ext.commands.every((o) => {
    if (o.pipe?.id !== id || o.pipe.index <= index) return true;
    const h = headName(o.argv[0]);
    return h !== undefined && LISTING_FILTERS.has(h) && !(h === "cat" && o.argv.length > 1) && !o.via.includes("exec");
  });
}

// --- routine development commands (auto mode) --------------------------------

const SCRIPT_NAMES = /^(test|t|lint|build|typecheck|type-check|check|format|fmt|compile)(:.+)?$/;
const NPX_TOOLS = new Set(["tsc", "vitest", "jest", "eslint", "prettier", "biome", "oxlint", "tsx", "playwright"]);

function routineVerdict(head: string, v: (string | undefined)[]): Verdict | undefined {
  const auto = (what: string): Verdict => ({ level: "auto", rule: "routine", reason: `routine development command: ${what}` });
  const sub = v[1];
  const global = v.some((x) => x === "-g" || x === "--global" || x === "--location=global");
  if (["npm", "pnpm", "yarn", "bun"].includes(head) && !global) {
    if (sub === undefined && head === "yarn") return auto("yarn install");
    if (sub === "test" || sub === "t" || sub === "ci") return auto(`${head} ${sub}`);
    if ((sub === "install" || sub === "i") && v.slice(2).every((x) => x !== undefined && x.startsWith("-"))) return auto(`${head} install`);
    if (sub === "run" && SCRIPT_NAMES.test(v[2] ?? "")) return auto(`${head} run ${v[2]}`);
    if (head !== "npm" && SCRIPT_NAMES.test(sub ?? "")) return auto(`${head} ${sub}`);
    if ((head === "pnpm" || head === "bun") && sub === "exec" && NPX_TOOLS.has(v[2] ?? "")) return auto(`${head} exec ${v[2]}`);
  }
  if ((head === "npx" || head === "bunx") && NPX_TOOLS.has(v[1] ?? "")) return auto(`${head} ${v[1]}`);
  if (NPX_TOOLS.has(head)) return auto(head);
  if (head === "cargo" && ["build", "check", "test", "clippy", "fmt", "doc", "bench"].includes(sub ?? "")) return auto(`cargo ${sub}`);
  if (head === "go" && ["build", "test", "vet", "fmt"].includes(sub ?? "")) return auto(`go ${sub}`);
  if (head === "make" && (sub === undefined || /^(test|build|check|lint|all|fmt|format)$/.test(sub))) return auto(`make ${sub ?? ""}`.trim());
  if (["pytest", "mypy", "pyright"].includes(head)) return auto(head);
  if (head === "ruff" && (sub === "check" || sub === "format")) return auto(`ruff ${sub}`);
  if ((head === "python" || head === "python3") && sub === "-m" && ["pytest", "unittest", "mypy", "ruff"].includes(v[2] ?? "")) return auto(`python -m ${v[2]}`);
  if (head === "uv" && (sub === "sync" || (sub === "run" && ["pytest", "mypy", "ruff"].includes(v[2] ?? "")))) return auto(`uv ${sub}`);
  if ((head === "gradlew" || head === "gradle") && ["test", "build", "check", "assemble"].includes(sub ?? "")) return auto(`gradle ${sub}`);
  if (head === "mvn" && ["test", "package", "verify", "compile"].includes(sub ?? "")) return auto(`mvn ${sub}`);
  return undefined;
}


// --- facts for the reviewer --------------------------------------------------

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASS|CREDENTIALS?|AUTH|COOKIE|SESSION)/i;

/**
 * What each variable in the command expands to when it runs, so the reviewer
 * judges real paths instead of guessing. Values of secret-looking variables are masked.
 */
export function commandVariables(command: string, ctx: PermissionContext): Record<string, string> {
  const ext = extract(command, ctx.cwd, ctx.home);
  const out: Record<string, string> = {};
  for (const c of ext.commands) {
    const words = [...c.argv, ...c.redirects.flatMap((r) => (r.target ? [r.target] : []))];
    for (const w of words) {
      for (const s of w.segments) {
        if (s.kind !== "var" || s.name in out) continue;
        const v = knownVar(s.name, c, ext, ctx);
        out[s.name] =
          v === undefined ? "(not known before it runs)"
          : v === PLACEHOLDER ? "(set at run time, never empty)"
          : v === "" ? "(unset or empty)"
          : SECRET_NAME.test(s.name) ? "(set, value hidden)"
          : v;
      }
    }
  }
  return out;
}
