/**
 * Which files a rewind touches, worked out from checkpoint entries in the
 * session tree. Pure: the git work (listing changed files) happens in the
 * caller.
 *
 * Each user message gets a `start` entry holding the tree captured right
 * before the agent saw it; each agent run ends with an `end` entry. A
 * segment is the agent's work for one user message: from its `start` tree to
 * the last `end` before the next `start`. Edits you make between runs fall
 * between an `end` and the next `start`, so they are never counted as agent
 * work and a rewind leaves them alone unless the agent touched the same file.
 */

export const CHECKPOINT_ENTRY = "b4agent-checkpoint";
export const REWIND_ENTRY = "b4agent-rewind";

export type CheckpointData = { kind: "start"; user: string; tree: string } | { kind: "end"; tree: string };

export interface RewindData {
  /** Tree captured just before the rewind, for undo. */
  safety: string;
  /** Paths the rewind changed. */
  files: string[];
  /** Set on the entry that undoes an earlier rewind. */
  undoes?: string;
  /** Conversation leaf before the rewind, when it moved the conversation, so undo can move it back. */
  leaf?: string | null;
}

/** The parts of a session entry we read. */
export interface EntryLike {
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
}

export interface Segment {
  /** The user message entry. */
  user: string;
  /** The `start` checkpoint entry. */
  startId: string;
  before: string;
  /** Undefined while the run is open, or when it ended without an `end` entry (a crash). */
  after?: string;
}

function checkpoint(e: EntryLike): CheckpointData | undefined {
  if (e.type !== "custom" || e.customType !== CHECKPOINT_ENTRY) return undefined;
  const d = e.data as Partial<CheckpointData> | undefined;
  if (typeof d?.tree !== "string") return undefined;
  if (d.kind === "start" && typeof (d as { user?: unknown }).user === "string") return d as CheckpointData;
  return d.kind === "end" ? (d as CheckpointData) : undefined;
}

/** Segments along one path of the session tree (root first). */
export function segments(path: readonly EntryLike[]): Segment[] {
  const out: Segment[] = [];
  let open: Segment | undefined;
  for (const e of path) {
    const c = checkpoint(e);
    if (!c) continue;
    if (c.kind === "start") {
      // A steering message mid-run: the previous segment ends where this one starts.
      if (open && open.after === undefined) open.after = c.tree;
      open = { user: c.user, startId: e.id, before: c.tree };
      out.push(open);
    } else if (open) {
      // Retries and continuations can append several `end`s; the last one wins.
      open.after = c.tree;
    }
  }
  return out;
}

export interface Change {
  segment: Segment;
  /** Paths that differ between the segment's before and after trees. */
  files: readonly string[];
}

export interface RestorePlan {
  /** Path to the tree whose version of it should be put back. */
  files: Map<string, string>;
  /** Path to the tree the file should currently match; a mismatch means someone edited it after the agent. */
  expected: Map<string, string>;
}

/**
 * Undo the segments on the branch we leave (newest last), then redo the ones
 * on the branch we go to. An undone file goes back to its state before the
 * earliest undone segment that touched it, as in OpenCode's revert. A redone
 * file takes the state after the latest redone segment that touched it.
 * `expected` is what each file should look like now if nobody else edited
 * it: the agent's last version on the branch we leave, or for files only
 * the other branch touched, the state before that branch changed them.
 */
export function planRestore(undo: readonly Change[], redo: readonly Change[] = []): RestorePlan {
  const files = new Map<string, string>();
  const expected = new Map<string, string>();
  for (const c of undo) {
    for (const f of c.files) {
      if (!files.has(f)) files.set(f, c.segment.before);
      if (c.segment.after) expected.set(f, c.segment.after);
    }
  }
  for (const c of redo) {
    if (!c.segment.after) continue;
    for (const f of c.files) {
      // A file only the other branch touched should still be as it was where the branches split.
      if (!expected.has(f)) expected.set(f, c.segment.before);
      files.set(f, c.segment.after);
    }
  }
  return { files, expected };
}

/** Segments to undo and redo when moving from one path to another. */
export function diffPaths(from: readonly EntryLike[], to: readonly EntryLike[]): { undo: Segment[]; redo: Segment[] } {
  const a = segments(from);
  const b = segments(to);
  const inA = new Set(a.map((s) => s.startId));
  const inB = new Set(b.map((s) => s.startId));
  return { undo: a.filter((s) => !inB.has(s.startId)), redo: b.filter((s) => !inA.has(s.startId)) };
}
