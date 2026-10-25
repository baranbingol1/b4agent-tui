import { posix } from "node:path";
import { type Arg, literalArg, staticValue } from "./words.js";

/** Command name as the shell would look it up, without a directory part. */
export function headName(arg: Arg | undefined): string | undefined {
  if (!arg) return undefined;
  const v = staticValue(arg);
  if (v === undefined) return undefined;
  return v.includes("/") ? posix.basename(v) : v;
}

export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "mksh", "busybox-sh"]);
const PRIVILEGE = new Set(["sudo", "doas", "su", "pkexec", "run0"]);

export type Nested =
  /** A script string to parse and check. `script` is undefined when it is not static. */
  | { kind: "script"; via: string; script: string | undefined; payload: Arg | undefined }
  /** A command line built from words, for example after `find -exec` or `xargs`. */
  | { kind: "argv"; via: string; argv: Arg[] };

export interface Unwrapped {
  argv: Arg[];
  wrappers: string[];
  privileged: boolean;
  /** Further commands this one runs. The outer command stays in `argv`. */
  nested: Nested[];
}

const DYNAMIC_INPUT: Arg = { text: "<stdin>", segments: [{ kind: "other", text: "<stdin>" }] };

function value(a: Arg | undefined): string | undefined {
  return a ? staticValue(a) : undefined;
}

/**
 * Skip options of a wrapper. `withValue` lists options that consume the next
 * word. Returns the index of the first non-option word.
 */
function skipOptions(argv: Arg[], start: number, withValue: Set<string>): number {
  let i = start;
  while (i < argv.length) {
    const v = value(argv[i]);
    if (v === undefined) return i;
    if (v === "--") return i + 1;
    if (!v.startsWith("-") || v === "-") return i;
    if (withValue.has(v)) i += 2;
    else if (v.startsWith("--") && v.includes("=")) i += 1;
    else i += 1;
  }
  return i;
}

const SUDO_VALUE = new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "-R", "--user", "--group", "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--command-timeout", "--chroot", "--close-from"]);
const ENV_VALUE = new Set(["-u", "--unset", "-C", "--chdir", "-a", "--argv0"]);
const TIME_VALUE = new Set(["-f", "--format", "-o", "--output"]);
const NICE_VALUE = new Set(["-n", "--adjustment"]);
const IONICE_VALUE = new Set(["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"]);
const TIMEOUT_VALUE = new Set(["-s", "--signal", "-k", "--kill-after"]);
const STDBUF_VALUE = new Set(["-i", "-o", "-e"]);
const STRACE_VALUE = new Set(["-o", "-e", "-p", "-s", "-u", "-E", "-S", "-a", "-b", "-I", "-O", "-P", "-X"]);
const XARGS_VALUE = new Set(["-I", "-n", "-P", "-d", "-L", "-s", "-a", "-E", "--max-args", "--max-procs", "--delimiter", "--max-lines", "--max-chars", "--arg-file", "--eof", "--replace"]);
const FLOCK_VALUE = new Set(["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"]);
const WATCH_VALUE = new Set(["-n", "--interval", "-d", "--differences", "-q", "--equexit", "--chgexit"]);
const EXEC_VALUE = new Set(["-a"]);
const SU_VALUE = new Set(["-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"]);

/**
 * Strips wrappers like `sudo`, `env`, `timeout` and `nohup` so the rules see
 * the command that actually runs, and lists the commands it runs in turn
 * (`sh -c`, `eval`, `find -exec`, `xargs`, ...). Wrappers nest:
 * `sudo env X=1 timeout 5 rm -rf /` unwraps to `rm -rf /`.
 */
export function unwrap(input: Arg[], limit = 16): Unwrapped {
  let argv = input;
  const wrappers: string[] = [];
  const nested: Nested[] = [];
  let privileged = false;

  for (let guard = 0; guard < limit; guard++) {
    const head = headName(argv[0]);
    if (head === undefined) break;
    let next: number | undefined;

    if (PRIVILEGE.has(head)) {
      privileged = true;
      if (head === "su") {
        // su [opts] [user] -c 'cmd'
        const c = argv.findIndex((a, i) => i > 0 && (value(a) === "-c" || value(a) === "--command"));
        if (c > 0) nested.push(script("su -c", argv[c + 1]));
        wrappers.push(head);
        return { argv, wrappers, privileged, nested };
      }
      if (head === "doas") next = skipOptions(argv, 1, new Set(["-u", "-C"]));
      else if (head === "pkexec") next = skipOptions(argv, 1, new Set(["--user"]));
      else if (head === "run0") next = skipOptions(argv, 1, new Set(["-u", "--user", "-g", "--group", "-D", "--chdir", "--unit", "--property", "--description", "--slice", "--nice", "--setenv", "--machine"]));
      else {
        next = skipOptions(argv, 1, SUDO_VALUE);
        // `sudo -s` / `sudo -i` with no command opens a shell; leave it as is.
      }
    } else if (head === "env") {
      let i = 1;
      while (i < argv.length) {
        const v = value(argv[i]);
        if (v === undefined) break;
        if (v === "-S" || v === "--split-string") {
          nested.push(script("env -S", argv[i + 1]));
          i = argv.length;
          break;
        }
        if (v.startsWith("-S") && v.length > 2) {
          nested.push(script("env -S", literalArg(v.slice(2))));
          i = argv.length;
          break;
        }
        if (v === "--") { i++; break; }
        if (ENV_VALUE.has(v)) { i += 2; continue; }
        if (v.startsWith("-")) { i++; continue; }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) { i++; continue; }
        break;
      }
      next = i;
    } else if (head === "command" || head === "builtin") {
      // `command -v x` / `command -V x` only look a name up.
      const v = value(argv[1]);
      if (v === "-v" || v === "-V") break;
      next = skipOptions(argv, 1, new Set());
    } else if (head === "exec") next = skipOptions(argv, 1, EXEC_VALUE);
    else if (head === "nohup" || head === "setsid" || head === "noglob" || head === "unbuffer" || head === "caffeinate" || head === "chronic") next = skipOptions(argv, 1, new Set(["-w"]));
    else if (head === "time") next = skipOptions(argv, 1, TIME_VALUE);
    else if (head === "nice") {
      next = skipOptions(argv, 1, NICE_VALUE);
    } else if (head === "ionice") next = skipOptions(argv, 1, IONICE_VALUE);
    else if (head === "timeout" || head === "gtimeout") {
      const i = skipOptions(argv, 1, TIMEOUT_VALUE);
      next = i + 1; // the duration
    } else if (head === "stdbuf") next = skipOptions(argv, 1, STDBUF_VALUE);
    else if (head === "strace" || head === "ltrace") next = skipOptions(argv, 1, STRACE_VALUE);
    else if (head === "chroot") {
      privileged = true;
      const i = skipOptions(argv, 1, new Set(["--userspec", "--groups"]));
      next = i + 1; // the new root
    } else if (head === "busybox" || head === "toybox") next = 1;
    else if (head === "flock") {
      const i = skipOptions(argv, 1, FLOCK_VALUE);
      // flock [opts] file -c 'cmd'  |  flock [opts] file cmd args
      const c = value(argv[i + 1]);
      if (c === "-c" || c === "--command") {
        nested.push(script("flock -c", argv[i + 2]));
        wrappers.push(head);
        return { argv, wrappers, privileged, nested };
      }
      next = i + 1;
    } else if (head === "watch") {
      const i = skipOptions(argv, 1, WATCH_VALUE);
      // watch joins its words and runs them with `sh -c`.
      const words = argv.slice(i);
      const parts = words.map(value);
      nested.push({ kind: "script", via: "watch", script: parts.every((p) => p !== undefined) ? parts.join(" ") : undefined, payload: words[0] });
      wrappers.push(head);
      return { argv, wrappers, privileged, nested };
    } else if (head === "xargs") {
      const i = skipOptions(argv, 1, XARGS_VALUE);
      const inner = argv.slice(i);
      nested.push({ kind: "argv", via: "xargs", argv: inner.length ? [...inner, DYNAMIC_INPUT] : [literalArg("echo"), DYNAMIC_INPUT] });
      wrappers.push(head);
      return { argv, wrappers, privileged, nested };
    } else if (head === "trap") {
      // trap 'cmd' SIGNAL...
      const first = value(argv[1]);
      if (first !== undefined && first !== "-p" && first !== "-l" && first !== "-" && argv.length > 2) nested.push(script("trap", argv[1]));
      break;
    } else if (head === "eval") {
      const words = argv.slice(1);
      const parts = words.map(value);
      nested.push({ kind: "script", via: "eval", script: parts.every((p) => p !== undefined) ? parts.join(" ") : undefined, payload: words.find((w) => value(w) === undefined) ?? words[0] });
      break;
    } else if (SHELLS.has(head)) {
      const c = shellCommandString(argv);
      if (c !== undefined) nested.push(script(head + " -c", argv[c]));
      break;
    } else if (head === "find") {
      nested.push(...findExec(argv));
      break;
    } else if (head === "fd" || head === "fdfind") {
      const x = argv.findIndex((a) => ["-x", "--exec", "-X", "--exec-batch"].includes(value(a) ?? ""));
      if (x > 0) nested.push({ kind: "argv", via: "fd -x", argv: [...argv.slice(x + 1), DYNAMIC_INPUT] });
      break;
    } else break;

    wrappers.push(head);
    if (next === undefined || next >= argv.length) {
      argv = [];
      break;
    }
    argv = argv.slice(next);
  }
  return { argv, wrappers, privileged, nested };
}

function script(via: string, payload: Arg | undefined): Nested {
  return { kind: "script", via, script: payload ? staticValue(payload) : undefined, payload };
}

/** Index of the script operand of `sh -c script`, accepting clusters like `-lc` or `-ec`. */
export function shellCommandString(argv: Arg[]): number | undefined {
  for (let i = 1; i < argv.length; i++) {
    const v = value(argv[i]);
    if (v === undefined) return undefined;
    if (v === "--") return undefined;
    if (v === "-c" || (/^-[a-zA-Z]+$/.test(v) && v.includes("c"))) return i + 1 < argv.length ? i + 1 : undefined;
    if (v === "-o" || v === "+o" || v === "-O" || v === "+O") { i++; continue; }
    if (!v.startsWith("-") && !v.startsWith("+")) return undefined;
  }
  return undefined;
}

/** The commands `find -exec`/`-execdir`/`-ok`/`-okdir` run. `{}` becomes a dynamic word. */
function findExec(argv: Arg[]): Nested[] {
  const out: Nested[] = [];
  for (let i = 1; i < argv.length; i++) {
    const v = value(argv[i]);
    if (v !== "-exec" && v !== "-execdir" && v !== "-ok" && v !== "-okdir") continue;
    const inner: Arg[] = [];
    let j = i + 1;
    for (; j < argv.length; j++) {
      const w = value(argv[j]);
      if (w === ";" || w === "+") break;
      inner.push(w === "{}" ? { text: "{}", segments: [{ kind: "other", text: "{}" }] } : argv[j]!);
    }
    if (inner.length) out.push({ kind: "argv", via: "find " + v, argv: inner });
    i = j;
  }
  return out;
}
