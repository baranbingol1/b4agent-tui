import { existsSync, readFileSync } from "node:fs";
import { configPath } from "../config.js";
import { DEFAULT_FALLBACK_MS } from "./pacer.js";
import { MIN_DELAY_MS } from "./scheduler.js";

export interface ScheduleSettings {
  /** The self-paced /loop's fallback wakeup; 0 turns it off (a round that doesn't reschedule ends the loop). */
  fallbackMs: number;
}

/** `schedule.fallbackWakeupMinutes` in b4agent.json (default 20; fractions allowed, at least 5 s; 0 turns it off). */
export function loadScheduleSettings(path = configPath(), errors: string[] = []): ScheduleSettings {
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = ((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).schedule ?? {}) as Record<string, unknown>;
    } catch (e) {
      errors.push(`could not parse ${path}: ${(e as Error).message}`);
    }
  }
  const m = raw.fallbackWakeupMinutes;
  if (m === undefined) return { fallbackMs: DEFAULT_FALLBACK_MS };
  if (typeof m !== "number" || !Number.isFinite(m) || m < 0) {
    errors.push("schedule.fallbackWakeupMinutes must be a number of minutes, 0 or more");
    return { fallbackMs: DEFAULT_FALLBACK_MS };
  }
  return { fallbackMs: m === 0 ? 0 : Math.max(MIN_DELAY_MS, Math.round(m * 60_000)) };
}
