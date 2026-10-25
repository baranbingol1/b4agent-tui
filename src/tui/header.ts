/**
 * The startup header: the b4agent wordmark in the banner gradient, a tip that
 * rotates between launches, the keys that are b4agent's own, and what this
 * session loaded.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GRADIENT_FROM, GRADIENT_TO } from "./spinner.js";
import type { Styler } from "./footer.js";

const BANNER = [
  "██████╗ ██╗  ██╗ █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "██╔══██╗██║  ██║██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██████╔╝███████║███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██╔══██╗╚════██║██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██████╔╝     ██║██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═════╝      ╚═╝╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];
const BANNER_WIDTH = 60;

export const TIPS: readonly string[] = [
  "Tab changes the reasoning effort; on GPT the next turn after a change reads no cache.",
  "Shift+Tab is spec mode: read-only planning that ends with a spec to approve.",
  "Alt+M cycles the permission mode: auto, manual, YOLO.",
  "Ctrl+O cycles the transcript: grouped steps, every step, full output.",
  "Ctrl+B moves a running command or a waited-on subagent to the background.",
  "/btw asks a side question without touching the main conversation.",
  "/rewind restores files and the conversation to an earlier message.",
  "/review gives your changes an adversarial pass; /changes lists what this session touched.",
  "Select transcript text with the mouse and press r to quote it into the prompt.",
  "/theme switches the colors with a live preview.",
];

/** Rows of [key, what it does]. These are b4agent's defaults (its keybindings.json); Pi's own keys are in /hotkeys. */
export const SHORTCUT_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [
    ["tab", "effort"],
    ["shift+tab", "spec mode"],
    ["alt+m", "permissions"],
  ],
  [
    ["ctrl+l", "model"],
    ["ctrl+o", "steps"],
    ["ctrl+b", "background"],
    ["/", "commands"],
  ],
];

export interface StartupInfo {
  tip: string;
  skills: number;
  agentsFiles: number;
}

/** Skills and context files in the system prompt Pi built (`<skill>` entries, `<project_instructions>` files). */
export function countLoaded(systemPrompt: string): { skills: number; agentsFiles: number } {
  const count = (re: RegExp) => systemPrompt.match(re)?.length ?? 0;
  return { skills: count(/^ {2}<skill>$/gm), agentsFiles: count(/<project_instructions path=/g) };
}

function gradientLine(line: string, row: number, rows: number): string {
  const k = rows <= 1 ? 0 : row / (rows - 1);
  const [r, g, b] = GRADIENT_FROM.map((from, i) => Math.round(from + (GRADIENT_TO[i]! - from) * k));
  return `\x1b[38;2;${r};${g};${b}m${line}\x1b[39m`;
}

/** The next tip in rotation; the index lives in `<dir>/.startup-tip`. */
export function nextTip(dir: string, tips: readonly string[] = TIPS): string {
  if (!tips.length) return "";
  const file = join(dir, ".startup-tip");
  let i = 0;
  try {
    const n = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    if (Number.isFinite(n) && n >= 0) i = n % tips.length;
  } catch {
    // first run
  }
  try {
    writeFileSync(file, String((i + 1) % tips.length));
  } catch {
    // the rotation is cosmetic
  }
  return tips[i]!;
}

export class Header {
  constructor(
    private readonly theme: Styler & { bold(text: string): string },
    private readonly info: StartupInfo | (() => StartupInfo),
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;
    const center = (s: string) => {
      const shown = visibleWidth(s) > width ? truncateToWidth(s, width, "…") : s;
      return " ".repeat(Math.max(0, Math.floor((width - visibleWidth(shown)) / 2))) + shown;
    };
    if (width < BANNER_WIDTH + 2) return ["", center(t.bold(t.fg("accent", "◤ b4agent"))), center(this.status()), ""];
    const out = [""];
    BANNER.forEach((line, i) => out.push(center(gradientLine(line, i, BANNER.length))));
    out.push("");
    const tip = this.current().tip;
    if (tip) out.push(center(`${t.bold(t.fg("accent", "TIP"))} ${t.fg("muted", tip)}`), "");
    for (const row of SHORTCUT_ROWS) out.push(center(row.map(([k, label]) => `${t.fg("accent", k)} ${t.fg("muted", label)}`).join(t.fg("dim", "   ·   "))));
    out.push("", center(this.status()), "");
    return out;
  }

  /** A getter is read on every render: extension skills load after session_start, so counts taken there are too early. */
  private current(): StartupInfo {
    return typeof this.info === "function" ? this.info() : this.info;
  }

  private status(): string {
    const t = this.theme;
    const mark = (ok: boolean) => (ok ? t.fg("success", "✓") : t.fg("dim", "–"));
    const { skills, agentsFiles } = this.current();
    return [
      `${t.fg("muted", "skills")} ${t.fg("text", String(skills))} ${mark(skills > 0)}`,
      `${t.fg("muted", "AGENTS.md")} ${t.fg("text", String(agentsFiles))} ${mark(agentsFiles > 0)}`,
    ].join(t.fg("dim", "    "));
  }
}
