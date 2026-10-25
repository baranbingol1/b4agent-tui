/**
 * Finding past sessions (plan section 2, the historian; Amp's find_thread).
 *
 * Pi 1.3 stores a session as JSONL in `<agentDir>/sessions/--<cwd with / as
 * ->--/<timestamp>_<id>.jsonl` (getDefaultSessionDirPath in Pi's
 * session-manager.js), or flat in a custom `--session-dir`. The first line is
 * the header (`type: "session"`, id, timestamp, cwd); `session_info` entries
 * carry the name; `message` entries the conversation.
 *
 * Pi's `SessionManager.list` parses every file fully and keeps all message
 * text in memory, and knows nothing about touched files, so search streams
 * the files itself: newest first by mtime, cheap date checks before opening a
 * file, tool results skipped without parsing, and it stops once it has the
 * page of matches it needs. Nothing here writes.
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, isAbsolute, join, posix, resolve } from "node:path";
import { createInterface } from "node:readline";
import { inProject, sessionDirName } from "./paths.js";
import { scrub } from "./redact.js";

export { inProject, sessionDirName };

export type Scope = "project" | "all";

/** Where to look. `project` sessions are those started in `root` or below it. */
export interface Places {
  /** `<agentDir>/sessions`. */
  sessionsRoot: string;
  /** The current session's directory (may be a custom flat `--session-dir`). */
  currentDir?: string;
  /** The project root (git root or cwd). */
  root: string;
  /** The current session file, marked in results. */
  currentFile?: string;
}

const inside = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** Directories that can hold sessions for the scope. For `project`, Pi's dirs for the root and any folder below it (the name is lossy, so headers are checked too). */
export function candidateDirs(places: Places, scope: Scope): string[] {
  const dirs = new Set<string>();
  if (places.currentDir) dirs.add(places.currentDir);
  if (existsSync(places.sessionsRoot)) {
    const own = sessionDirName(places.root);
    const below = own.slice(0, -2) + "-";
    for (const d of readdirSync(places.sessionsRoot, { withFileTypes: true })) {
      if (!d.isDirectory() && !d.isSymbolicLink()) continue;
      if (scope === "all" || d.name === own || d.name.startsWith(below)) dirs.add(join(places.sessionsRoot, d.name));
    }
  }
  return [...dirs];
}

interface Candidate {
  path: string;
  mtime: number;
  /** From the file name (`2026-10-21T10-00-00-000Z_<id>.jsonl`), when it has one. */
  created?: number;
}

function fileCreated(name: string): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (!m) return undefined;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? undefined : t;
}

export function listCandidates(dirs: string[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dir, name);
      if (seen.has(path)) continue;
      seen.add(path);
      try {
        const st = statSync(path);
        if (!st.isFile()) continue;
        const created = fileCreated(name);
        out.push({ path, mtime: st.mtimeMs, ...(created !== undefined ? { created } : {}) });
      } catch {
        // Gone or unreadable.
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime || basename(b.path).localeCompare(basename(a.path)));
}

/** `2026-10-01`, an ISO time, or a relative `30m`, `12h`, `7d`, `2w` (before now). */
export function parseWhen(s: string, now = Date.now()): number | undefined {
  const t = s.trim();
  const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(t);
  if (rel) return now - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2]!.toLowerCase() as "m"]!;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) {
    const v = Date.parse(t);
    return Number.isNaN(v) ? undefined : v;
  }
  return undefined;
}

export interface SearchQuery {
  /** Words or "quoted phrases"; every one must occur in the session's user or assistant text (case-insensitive). */
  query?: string;
  /** A path the session touched through a tool call (absolute, relative to the session's cwd, or a trailing part like `src/a.ts`). */
  file?: string;
  /** Last activity at or after / before (Amp's `after:` / `before:` use the update time too). */
  after?: number;
  before?: number;
  scope: Scope;
  limit: number;
  offset: number;
}

export interface SessionHit {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  /** The first user message, one line. */
  first: string;
  created: number;
  modified: number;
  /** User messages. */
  turns: number;
  snippet?: string;
  /** Touched paths that matched `file`. */
  files?: string[];
  current?: boolean;
}

export interface SearchResult {
  hits: SessionHit[];
  /** Sessions opened. */
  scanned: number;
  /** Sessions in scope before any filter. */
  total: number;
  /** True when it stopped early: more matches may follow at `offset + limit`. */
  more: boolean;
}

export function terms(query: string): string[] {
  const out: string[] = [];
  for (const m of query.matchAll(/"([^"]+)"|(\S+)/g)) {
    const t = (m[1] ?? m[2] ?? "").trim().toLowerCase();
    if (t) out.push(t);
  }
  return out;
}

/** Tool arguments that name a file. */
const PATH_KEYS = ["path", "file_path", "filePath", "file", "paths", "files"];

function touched(args: unknown, cwd: string): string[] {
  if (!args || typeof args !== "object") return [];
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v !== "string" || !v || v.length > 1000) return;
    const p = v.startsWith("~/") ? v : isAbsolute(v) ? posix.normalize(v) : cwd ? posix.resolve(cwd, v) : v;
    out.push(p);
  };
  for (const k of PATH_KEYS) {
    const v = (args as Record<string, unknown>)[k];
    if (Array.isArray(v)) v.forEach(add);
    else add(v);
  }
  return out;
}

/** Whether a touched path matches the `file` filter: same absolute path, or ends with it at a path boundary. */
export function fileMatches(touchedPath: string, file: string, cwd: string): boolean {
  const f = file.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (!f) return false;
  if (isAbsolute(f)) return touchedPath === posix.normalize(f) || inside(touchedPath, posix.normalize(f));
  if (cwd && touchedPath === posix.resolve(cwd, f)) return true;
  return touchedPath === f || touchedPath.endsWith(`/${f}`) || inside(touchedPath, f) || touchedPath.includes(`/${f}/`);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: { type?: string; text?: string }) => (c?.type === "text" && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
}

const oneLine = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function snippetAround(text: string, term: string, width = 240): string {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return oneLine(flat, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width);
  return `${start > 0 ? "…" : ""}${piece.trim()}${start + width < flat.length ? "…" : ""}`;
}

/** A message line whose role makes it irrelevant to search: tool output is neither user nor assistant text. */
const SKIP_LINE = /"role"\s*:\s*"(toolResult|bashExecution)"/;

/**
 * Streams one session file. Returns undefined when it isn't a session or
 * fails a filter; otherwise the hit. Never reads the file into memory whole.
 */
export async function scanSession(path: string, q: Omit<SearchQuery, "limit" | "offset" | "scope"> & { root?: string }, signal?: AbortSignal): Promise<SessionHit | undefined> {
  const want = q.query ? terms(q.query) : [];
  const found = new Set<string>();
  let snippet: string | undefined;
  const files = new Set<string>();
  let header: { id: string; cwd: string; timestamp: string } | undefined;
  let name: string | undefined;
  let first = "";
  let turns = 0;
  let last = 0;
  const stream = createReadStream(path, { encoding: "utf8", ...(signal ? { signal } : {}) });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line) continue;
      if (!header) {
        let h: Record<string, unknown>;
        try {
          h = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
        if (h.type !== "session" || typeof h.id !== "string") return undefined;
        header = { id: h.id, cwd: typeof h.cwd === "string" ? h.cwd : "", timestamp: String(h.timestamp ?? "") };
        if (q.root && !inProject(header.cwd, q.root)) return undefined;
        continue;
      }
      // Tool output is the bulk of a session; it can't match, so skip it unparsed. The role sits near the start of the line.
      if (SKIP_LINE.test(line.slice(0, 300))) continue;
      let e: Record<string, any>;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "session_info") {
        name = typeof e.name === "string" && e.name.trim() ? e.name.trim() : undefined;
        continue;
      }
      if (e.type !== "message" || !e.message) continue;
      const m = e.message;
      const ts = typeof m.timestamp === "number" ? m.timestamp : Date.parse(e.timestamp);
      if (Number.isFinite(ts)) last = Math.max(last, ts);
      if (m.role === "user") {
        turns++;
        const text = textOf(m.content);
        if (!first && text) first = oneLine(scrub(text), 120);
        matchText(text);
      } else if (m.role === "assistant") {
        matchText(textOf(m.content));
        if (q.file && Array.isArray(m.content)) {
          for (const c of m.content) if (c?.type === "toolCall") for (const p of touched(c.arguments, header.cwd)) if (fileMatches(p, q.file, header.cwd)) files.add(p);
        }
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  if (!header) return undefined;
  if (want.length && found.size < want.length) return undefined;
  if (q.file && !files.size) return undefined;
  const created = Date.parse(header.timestamp);
  const modified = last || (Number.isNaN(created) ? 0 : created);
  if (q.after !== undefined && modified < q.after) return undefined;
  if (q.before !== undefined && modified >= q.before) return undefined;
  return {
    id: header.id,
    path,
    cwd: header.cwd,
    ...(name ? { name: oneLine(scrub(name), 120) } : {}),
    first: first || "(no messages)",
    created: Number.isNaN(created) ? modified : created,
    modified,
    turns,
    ...(snippet ? { snippet } : {}),
    ...(files.size ? { files: [...files].slice(0, 5) } : {}),
  };

  function matchText(text: string) {
    if (!want.length || !text) return;
    const lower = text.toLowerCase();
    let hitHere: string | undefined;
    for (const t of want) {
      if (lower.includes(t)) {
        found.add(t);
        hitHere ??= t;
      }
    }
    // The snippet comes from the first message with the first term, redacted before it is cut.
    if (!snippet && hitHere === want[0]) snippet = snippetAround(scrub(text), want[0]!);
  }
}

const CONCURRENCY = 8;

/** Newest first; opens files in small batches and stops once it has `offset + limit` matches. */
export async function searchSessions(places: Places, q: SearchQuery, signal?: AbortSignal): Promise<SearchResult> {
  const all = listCandidates(candidateDirs(places, q.scope));
  // mtime is at or after the last activity, and the file name's time is the start: both rule files out without opening them.
  const pool = all.filter((c) => (q.after === undefined || c.mtime >= q.after) && (q.before === undefined || c.created === undefined || c.created < q.before));
  const need = q.offset + q.limit;
  const hits: SessionHit[] = [];
  let scanned = 0;
  let i = 0;
  const filter = { ...(q.query ? { query: q.query } : {}), ...(q.file ? { file: q.file } : {}), ...(q.after !== undefined ? { after: q.after } : {}), ...(q.before !== undefined ? { before: q.before } : {}), ...(q.scope === "project" ? { root: places.root } : {}) };
  while (i < pool.length && hits.length < need) {
    signal?.throwIfAborted();
    const batch = pool.slice(i, i + CONCURRENCY);
    i += batch.length;
    scanned += batch.length;
    const got = await Promise.all(batch.map((c) => scanSession(c.path, filter, signal).catch(() => undefined)));
    for (const h of got) if (h) hits.push(h);
  }
  hits.sort((a, b) => b.modified - a.modified);
  const page = hits.slice(q.offset, need).map((h) => (places.currentFile && resolve(h.path) === resolve(places.currentFile) ? { ...h, current: true } : h));
  return { hits: page, scanned, total: all.length, more: i < pool.length || hits.length > need };
}

/**
 * Finds a session by id (or a unique id prefix of 6+ characters) in the
 * scope's directories, reading only headers (the id is in the file name, so
 * that's tried first).
 */
export async function findSession(places: Places, ref: string, scope: Scope): Promise<{ path: string } | { error: string }> {
  const id = ref.trim().replace(/^@/, "");
  if (id.length < 6) return { error: "Give a session id (at least 6 characters of it) or a path." };
  const all = listCandidates(candidateDirs(places, scope));
  const named = all.filter((c) => basename(c.path, ".jsonl").endsWith(`_${id}`) || basename(c.path, ".jsonl") === id);
  const prefixed = named.length ? named : all.filter((c) => (basename(c.path, ".jsonl").split("_")[1] ?? "").startsWith(id));
  const matches: string[] = [];
  for (const c of prefixed.length ? prefixed : all) {
    const h = await readHeader(c.path);
    if (!h) continue;
    if (h.id !== id && !(id.length >= 6 && h.id.startsWith(id))) continue;
    if (scope === "project" && !inProject(h.cwd, places.root)) continue;
    matches.push(c.path);
    if (h.id === id) return { path: c.path };
  }
  if (matches.length === 1) return { path: matches[0]! };
  if (matches.length > 1) return { error: `"${id}" matches ${matches.length} sessions; give more of the id.` };
  return { error: scope === "project" ? `No session of this project has id "${id}". Sessions of other projects need scope: "all".` : `No session has id "${id}".` };
}

export async function readHeader(path: string): Promise<{ id: string; cwd: string; timestamp: string } | undefined> {
  const stream = createReadStream(path, { encoding: "utf8", start: 0, end: 64 * 1024 });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      const h = JSON.parse(line) as Record<string, unknown>;
      if (h.type !== "session" || typeof h.id !== "string") return undefined;
      return { id: h.id, cwd: typeof h.cwd === "string" ? h.cwd : "", timestamp: String(h.timestamp ?? "") };
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
    stream.destroy();
  }
  return undefined;
}
