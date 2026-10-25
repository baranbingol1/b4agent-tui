import { existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * The `environment` prompt section (plan section 5): OS, shell, Node, home,
 * time zone and the date. Pi's own `cwd` section already has the working
 * directory. The text is built once per session and never changes inside
 * it (no clock time), so it never breaks the prompt cache; a resumed session
 * gets today's date, and Pi sends that one section as an update.
 */

export interface EnvironmentFacts {
  os: string;
  platform: string;
  arch: string;
  shell: string;
  node: string;
  home: string;
  timeZone: string;
  date: string;
}

/** A shell path as the model should read it. */
export function describeShell(shellPath: string): string {
  const name = path.basename(shellPath).replace(/\.exe$/i, "");
  return name === shellPath ? name : `${name} (${shellPath})`;
}

export function detectEnvironment(now = new Date()): EnvironmentFacts {
  // The shell b4agent's bash tool spawns (src/jobs/bash.ts), not the one that started b4agent.
  const shell = describeShell(existsSync("/bin/bash") ? "/bin/bash" : "bash");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // The local calendar date, which is what "today" means to the user.
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return { os: `${os.type()} ${os.release()}`, platform: process.platform, arch: os.arch(), shell, node: process.version, home: os.homedir(), timeZone, date };
}

export function environmentSection(f: EnvironmentFacts): string {
  return [
    `Operating system: ${f.os} (${f.platform}, ${f.arch})`,
    `Shell used by the bash tool: ${f.shell}`,
    `Node.js: ${f.node}`,
    `Home directory: ${f.home}`,
    `Time zone: ${f.timeZone}`,
    `Date: ${f.date} (when this session was opened; not updated while it runs)`,
  ].join("\n");
}

/** Tools that only make sense with someone at the keyboard. */
export const INTERACTIVE_ONLY_TOOLS = ["ask_user", "agent_create"];

export const HEADLESS_SECTION =
  "Nobody is watching this session: it runs non-interactively, so no one can answer questions or approve actions. When a decision would normally be the user's, make a reasonable choice, carry the work through, and state the assumptions in your final message.";

/** Print, JSON and RPC runs have no one to ask: the same test ask_user uses. */
export function isHeadless(ctx: Pick<ExtensionContext, "hasUI" | "mode">): boolean {
  return !ctx.hasUI || ctx.mode !== "tui";
}

export default function environment(pi: ExtensionAPI) {
  let text: string | undefined;
  // Drop the interactive-only tools before the first request, so the tool list (and the cache) stays the same for the whole session.
  const dropInteractiveTools = (ctx: ExtensionContext) => {
    if (!isHeadless(ctx)) return;
    const active = pi.getActiveTools();
    if (active.some((t) => INTERACTIVE_ONLY_TOOLS.includes(t))) pi.setActiveTools(active.filter((t) => !INTERACTIVE_ONLY_TOOLS.includes(t)));
  };
  pi.on("session_start", (_event, ctx) => {
    text = undefined;
    dropInteractiveTools(ctx);
  });
  pi.on("before_agent_start", (event, ctx) => {
    dropInteractiveTools(ctx);
    text ??= environmentSection(detectEnvironment());
    event.systemPromptOptions.sections.environment = text;
    if (isHeadless(ctx)) event.systemPromptOptions.sections.headless = HEADLESS_SECTION;
  });
}
