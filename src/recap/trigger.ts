import { existsSync, readFileSync } from "node:fs";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { configPath } from "../config.js";

/**
 * When a thread recap may run (plan section 3): the user has been away (no
 * keystrokes for a while), the session has 3+ completed turns, at least one
 * new turn since the last recap, nothing typed in the editor, and the agent
 * is idle. Pure functions over session entries, so tests need no terminal.
 */

export const RECAP_ENTRY = "recap";

/** What `pi.appendEntry("recap", …)` saves. It never reaches the model. */
export interface SavedRecap {
  text: string;
  next?: string;
  /** The conversation leaf the recap describes (see `conversationLeaf`). */
  leafId: string | null;
  /** `provider/id` of the model that wrote it. */
  model: string;
  /** "main": a side turn on the main model with the main prefix; "small": the recap role with a short input. */
  route?: "main" | "small";
  usage?: { input: number; cacheRead: number; output: number };
}

export interface RecapSettings {
  enabled: boolean;
  /** No keystrokes for this long counts as away. */
  awayMs: number;
  minTurns: number;
  /** How long the main model's prompt cache is assumed warm when the model doesn't say. */
  cacheTtlMs: number;
}

export const DEFAULT_RECAP: RecapSettings = { enabled: true, awayMs: 180_000, minTurns: 3, cacheTtlMs: 300_000 };

/**
 * `recap` in b4agent.json (`enabled`, `awaySeconds`, `minTurns`, `cacheTtlSeconds`),
 * then `B4AGENT_RECAP_AWAY_SECONDS` from the environment, which wins.
 */
export function loadRecapSettings(env: NodeJS.ProcessEnv = process.env, path = configPath(), errors: string[] = []): RecapSettings {
  const s = { ...DEFAULT_RECAP };
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = ((JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>).recap ?? {}) as Record<string, unknown>;
    } catch (e) {
      errors.push(`could not parse ${path}: ${(e as Error).message}`);
    }
  }
  const seconds = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1000 : undefined);
  if (typeof raw.enabled === "boolean") s.enabled = raw.enabled;
  s.awayMs = seconds(raw.awaySeconds) ?? s.awayMs;
  s.cacheTtlMs = seconds(raw.cacheTtlSeconds) ?? s.cacheTtlMs;
  if (typeof raw.minTurns === "number" && raw.minTurns >= 1) s.minTurns = Math.floor(raw.minTurns);
  const fromEnv = env.B4AGENT_RECAP_AWAY_SECONDS;
  if (fromEnv !== undefined && fromEnv !== "") {
    const ms = seconds(Number(fromEnv));
    if (ms === undefined) errors.push(`B4AGENT_RECAP_AWAY_SECONDS must be a number of seconds, got "${fromEnv}"`);
    else s.awayMs = ms;
  }
  return s;
}

/** Entry types that change what the model sees. Custom entries (recaps, checkpoints, /btw), labels and model changes don't. */
const CONVERSATION = new Set(["message", "custom_message", "compaction", "branch_summary", "context_edit"]);

/**
 * The id of the last entry on the branch that changes the conversation. Pi's
 * own leaf moves with every custom entry (the recap's own, a checkpoint), so
 * comparing raw leaf ids would call a recap stale for no reason.
 */
export function conversationLeaf(branch: readonly SessionEntry[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) if (CONVERSATION.has(branch[i]!.type)) return branch[i]!.id;
  return null;
}

export interface Conversation {
  /** Completed user turns on the branch: a user message whose run ended without an error or abort. */
  turns: number;
  /** Completed turns after the last saved recap on the branch. */
  turnsSinceRecap: number;
  leafId: string | null;
  lastRecap?: SavedRecap;
}

type Msg = { role?: string; stopReason?: string };

export function readConversation(branch: readonly SessionEntry[]): Conversation {
  let turns = 0;
  let since = 0;
  let lastRecap: SavedRecap | undefined;
  // A turn is open from a user message until the next one; it counts once its last assistant reply is a clean stop.
  let open = false;
  let lastStop: string | undefined;
  const close = () => {
    if (open && lastStop !== undefined && lastStop !== "error" && lastStop !== "aborted") {
      turns++;
      since++;
    }
    open = false;
    lastStop = undefined;
  };
  for (const e of branch) {
    if (e.type === "custom" && e.customType === RECAP_ENTRY) {
      // A recap describes the turns before it (it is only saved while the agent is idle).
      close();
      since = 0;
      lastRecap = e.data as SavedRecap;
      continue;
    }
    if (e.type !== "message") continue;
    const m = e.message as Msg;
    if (m.role === "user") {
      close();
      open = true;
    } else if (m.role === "assistant" && open) lastStop = m.stopReason;
  }
  close();
  return { turns, turnsSinceRecap: since, leafId: conversationLeaf(branch), ...(lastRecap ? { lastRecap } : {}) };
}

export interface RecapState {
  conversation: Conversation;
  draft: string;
  /** Agent not streaming, nothing queued, no dialog waiting on the user. */
  idle: boolean;
}

/** Why a recap may not run now, or undefined when it may. */
export function recapBlocker(s: RecapState, settings: Pick<RecapSettings, "minTurns">): string | undefined {
  if (s.conversation.turns < settings.minTurns) return `fewer than ${settings.minTurns} completed turns`;
  if (s.conversation.turnsSinceRecap < 1) return "no new turn since the last recap";
  if (s.draft.trim()) return "a draft in the editor";
  if (!s.idle) return "the agent is busy";
  return undefined;
}

/**
 * Whether raw terminal input means someone is at the keyboard. Focus reports
 * (DEC 1004) and bare mouse motion don't: an inline terminal may report focus
 * without a key, and a pointer drifting over the window isn't a person typing.
 */
export function isPresence(data: string): boolean {
  if (data === "\x1b[I" || data === "\x1b[O") return false;
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  if (sgr) {
    const button = Number(sgr[1]);
    // Bit 32 is motion; with no button held (low bits 3) it is a plain move.
    if (button & 32 && (button & 3) === 3) return false;
  }
  return data.length > 0;
}
