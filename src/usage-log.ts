/**
 * Usage of model calls made outside the agent loop (reviewer, auto-title,
 * session digest, web_fetch prompt mode, web_search). Those calls never reach
 * a session file, so benchmarks that sum session usage would miss them. With
 * `B4AGENT_USAGE_LOG=<file>` set, each call appends one JSON line there.
 */
import { appendFileSync } from "node:fs";

export interface SideUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}

export function logSideUsage(kind: string, model: string, usage: SideUsage | undefined): void {
  const file = process.env.B4AGENT_USAGE_LOG;
  if (!file || !usage) return;
  try {
    appendFileSync(file, `${JSON.stringify({ ts: Date.now(), kind, model, usage })}\n`);
  } catch {
    // Accounting must never break the call it accounts for.
  }
}
