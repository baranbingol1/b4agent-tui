#!/usr/bin/env node
/**
 * The `b4agent` command (plan sections 0 and 5): Pi with b4agent's
 * extensions, keeping its state in ~/.b4agent/agent instead of ~/.pi.
 * PI_CODING_AGENT_DIR has to be set before Pi is imported.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = process.env.B4AGENT_HOME ?? join(homedir(), ".b4agent");
const agentDir = (process.env.PI_CODING_AGENT_DIR ??= join(home, "agent"));

/** First run only: b4agent's defaults, and your existing Pi logins. Files you already have are never touched. */
function firstRun() {
  mkdirSync(agentDir, { recursive: true });
  const settings = join(agentDir, "settings.json");
  if (!existsSync(settings)) {
    // Plan section 10: the main role, gpt-6.1-sol at high effort through the ChatGPT login.
    writeFileSync(settings, JSON.stringify({ defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "high" }, null, 2) + "\n");
  }
  const keys = join(agentDir, "keybindings.json");
  if (!existsSync(keys)) {
    // Tab cycles reasoning effort; autocomplete moves to Shift+Right; Shift+Tab is spec mode (plan section 13).
    writeFileSync(keys, JSON.stringify({ "app.thinking.cycle": "tab", "tui.input.tab": "shift+right" }, null, 2) + "\n");
  }
  const auth = join(agentDir, "auth.json");
  const piAuth = join(homedir(), ".pi", "agent", "auth.json");
  if (!existsSync(auth) && existsSync(piAuth) && agentDir !== join(homedir(), ".pi", "agent")) {
    copyFileSync(piAuth, auth);
    chmodSync(auth, 0o600);
    process.stderr.write(`b4agent: copied your Pi logins from ${piAuth} to ${auth}.\n`);
  }
}

/** Pi prints "pi --session <id>" as the resume hint; point it at b4agent. */
function shimResumeHint() {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string" && chunk.includes("--session")) chunk = chunk.replace(/\bpi (?=--session)/g, "b4agent ");
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
}

async function run() {
  try {
    firstRun();
  } catch (e) {
    process.stderr.write(`b4agent: setup skipped: ${(e as Error).message}\n`);
  }
  shimResumeHint();
  const { main } = await import("@earendil-works/pi-coding-agent");
  const { makeExtension } = await import("./extension/index.js");
  const { assetDir } = await import("./prompt.js");
  // Bundled themes go in through --theme, because Pi applies the saved theme before extensions register theirs.
  const args = process.argv.slice(2);
  if (!args.includes("--no-themes")) args.push("--theme", assetDir("themes"));
  await main(args, { extensionFactories: [{ name: "b4agent", factory: makeExtension() }] });
}

run().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
