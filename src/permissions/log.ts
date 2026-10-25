import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Append-only JSONL audit log of every call the gate did not simply allow:
 * reviews, prompts, blocks, and what ran in YOLO. The agent can't write it
 * (own-guard rule). Rotates once to `.1` at 10 MiB.
 */
export function createLog(path: string): (entry: Record<string, unknown>) => void {
  return (entry) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      try {
        if (statSync(path).size > MAX_BYTES) renameSync(path, path + ".1");
      } catch {
        // no log yet
      }
      appendFileSync(path, JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n", { mode: 0o600 });
    } catch {
      // The log must never break a tool call.
    }
  };
}
