/**
 * Where URLs came from, for web_fetch's provenance rule (plan section 18,
 * point 2): URLs in the user's messages and in earlier web_fetch /
 * web_search results count as seen. URLs the agent wrote itself, or found in
 * files or command output, don't.
 */
import { normalizeForMatch } from "../permissions/rules/web.js";

const URL_RE = /https?:\/\/[^\s<>"'`\\)\]}]+/gi;

/** URLs in free text (prose, markdown links, JSON), trailing punctuation removed. */
export function extractUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?*_~]+$/, "");
    const n = normalizeForMatch(u);
    if (n) out.push(n);
  }
  return out;
}

const WEB_TOOLS = new Set(["web_fetch", "web_search"]);

type Content = string | { type: string; text?: string }[];
interface BranchEntry {
  type: string;
  message?: { role?: string; toolName?: string; content?: Content };
}

const textOf = (c: Content | undefined) => (typeof c === "string" ? c : (c ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("\n"));

/**
 * The seen-URL set from a session branch. A subagent passes the main
 * session's user messages as `userTexts` and `branchUsers: false`: its own
 * "user" message is a brief another agent wrote, so its URLs don't count.
 */
export function seenUrls(entries: readonly BranchEntry[], opts: { userTexts?: readonly string[]; branchUsers?: boolean } = {}): Set<string> {
  const seen = new Set<string>();
  for (const t of opts.userTexts ?? []) for (const u of extractUrls(t)) seen.add(u);
  const users = opts.branchUsers ?? true;
  for (const e of entries) {
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    if ((users && m.role === "user") || (m.role === "toolResult" && WEB_TOOLS.has(String(m.toolName ?? "").toLowerCase()))) {
      for (const u of extractUrls(textOf(m.content))) seen.add(u);
    }
  }
  return seen;
}
