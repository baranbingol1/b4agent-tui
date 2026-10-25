import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { b4agentDir } from "../permissions/config.js";

/**
 * The TUI pieces' options in `~/.b4agent/b4agent.json`. Every key is
 * optional; a bad value keeps its default.
 *
 *   "spinner": false,
 *   "notify": { "bell": true, "minRunSeconds": 20 },
 *   "diagnostics": { "enabled": true, "command": "npm run typecheck" },
 *   "autotitle": true
 */
export interface TuiSettings {
  spinner: boolean;
  notify: { bell: boolean; minRunSeconds: number };
  diagnostics: { enabled: boolean; command?: string };
  autotitle: boolean;
}

export const DEFAULT_TUI_SETTINGS: TuiSettings = {
  spinner: true,
  notify: { bell: true, minRunSeconds: 20 },
  diagnostics: { enabled: true },
  autotitle: true,
};

export function parseTuiSettings(raw: Record<string, unknown>): TuiSettings {
  const d = DEFAULT_TUI_SETTINGS;
  const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const notify = obj(raw.notify);
  const diag = obj(raw.diagnostics);
  const min = notify.minRunSeconds;
  const command = typeof diag.command === "string" && diag.command.trim() ? diag.command.trim() : undefined;
  return {
    spinner: bool(raw.spinner, d.spinner),
    notify: { bell: bool(notify.bell, d.notify.bell), minRunSeconds: typeof min === "number" && min >= 0 ? min : d.notify.minRunSeconds },
    diagnostics: { enabled: bool(diag.enabled, d.diagnostics.enabled), ...(command ? { command } : {}) },
    autotitle: bool(raw.autotitle, d.autotitle),
  };
}

/** Read on every session start, so an edit applies to the next session. Unreadable files give the defaults. */
export function loadTuiSettings(dir = b4agentDir()): TuiSettings {
  const path = join(dir, "b4agent.json");
  if (!existsSync(path)) return DEFAULT_TUI_SETTINGS;
  try {
    return parseTuiSettings(JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>);
  } catch {
    return DEFAULT_TUI_SETTINGS;
  }
}
