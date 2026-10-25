import type { Verdict } from "../types.js";

/**
 * Hard-deny patterns for commands the parser could not read (syntax errors,
 * over 10k characters). They run on a normalized copy of the raw text, so they
 * are deliberately narrow: a false positive here blocks the call outright.
 */
export function regexFallback(raw: string): Verdict | undefined {
  const text = normalize(raw);
  for (const [rule, re, reason] of PATTERNS) {
    if (re.test(text)) return { level: "deny", rule, reason: `${reason} (matched in a command the parser could not read)`, fix: "Rewrite the command so it parses, and avoid the destructive part." };
  }
  return undefined;
}

const CMD = String.raw`(?:^|[\n;&|({]|\$\(|\x60)\s*(?:sudo\s+(?:-\S+\s+)*)?`;

const PATTERNS: [string, RegExp, string][] = [
  ["critical-path-delete", new RegExp(CMD + String.raw`rm\s+(?:-\S+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(?:-\S+\s+)*["']?(?:/|/\*|~|~/|\$HOME|\$\{HOME\})["']?(?:\s|$|[;&|)])`), "recursive delete of / or ~"],
  ["no-preserve-root", /--no-preserve-root\b/, "--no-preserve-root"],
  ["disk-format", new RegExp(CMD + String.raw`(?:mkfs(?:\.\w+)?|wipefs|blkdiscard)\b`), "disk format"],
  ["raw-device-write", /\bdd\b[^\n;|&]*\bof=\/dev\/(?:sd|nvme|hd|vd|xvd|mmcblk|disk)/, "dd to a block device"],
  ["raw-device-write", />\s*\/dev\/(?:sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d)/, "redirect to a block device"],
  ["fork-bomb", /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, "fork bomb"],
  ["power", new RegExp(CMD + String.raw`(?:shutdown|reboot|halt|poweroff)\b`), "shutdown or reboot"],
];

/** Undo the cheap spelling tricks: escapes, empty quotes, $IFS, line continuations. */
export function normalize(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/\0/g, "")
    .replace(/\\\n/g, "")
    .replace(/\$\{?IFS\}?/g, " ")
    .replace(/(['"])\1/g, "")
    .replace(/\\([a-zA-Z])/g, "$1");
}
