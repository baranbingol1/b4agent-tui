import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_ENTRY, diffPaths, planRestore, REWIND_ENTRY, segments, type Change, type EntryLike, type RewindData, type Segment } from "../checkpoints/plan.js";
import { CheckpointStore, MAX_UNTRACKED_BYTES, setCheckpointStatus } from "../checkpoints/store.js";
import { b4agentDir } from "../permissions/config.js";
import { gitInfo } from "../permissions/git.js";
import { currentHub } from "../agents/hub.js";

type Entry = EntryLike & { parentId: string | null; timestamp?: string; message?: { role: string; content: unknown; timestamp?: number } };

interface Prepared {
  /** Tree of the files as they are now; also the safety snapshot for undo. */
  current: string;
  /** Path to the tree to restore it from, only paths whose content actually changes. */
  files: Map<string, string>;
  /** Paths edited after the agent's last change to them (by you or another process). */
  conflicts: string[];
  added: number;
  deleted: number;
}

/**
 * File checkpoints and /rewind (plan section 17). A tree is captured before
 * every user message and at the end of every agent run; rewinding restores
 * only the files the agent changed since that message.
 */
export default function checkpoints(pi: ExtensionAPI) {
  const dir = b4agentDir();
  const home = process.env.HOME ?? homedir();
  let store: CheckpointStore | undefined;
  let workspace = process.cwd();
  let pending: { timestamp: number; tree: string } | undefined;
  /** Set while /rewind moves the conversation, so the /tree hook doesn't ask again. */
  let navigating = false;
  /** Pi's isIdle() is false during /tree navigation itself, so track agent runs here. */
  let running = false;
  const warnedLarge = new Set<string>();

  function disable(ctx: ExtensionContext, reason: string) {
    store = undefined;
    setCheckpointStatus(workspace, { ok: false, reason });
    ctx.ui.notify(`Checkpoints are off for this session: ${reason}`, "warning");
  }

  pi.on("session_start", async (_event, ctx) => {
    const git = gitInfo(ctx.cwd);
    workspace = git.root ?? ctx.cwd;
    pending = undefined;
    store = undefined;
    try {
      store = await CheckpointStore.open(workspace, dir, { inGit: Boolean(git.root), home });
      setCheckpointStatus(workspace, { ok: true });
    } catch (e) {
      disable(ctx, (e as Error).message);
    }
  });

  async function capture(ctx: ExtensionContext): Promise<string | undefined> {
    if (!store) return undefined;
    try {
      const r = await store.capture();
      const fresh = r.skipped.filter((p) => !warnedLarge.has(p));
      for (const p of fresh) warnedLarge.add(p);
      if (fresh.length) {
        const mib = MAX_UNTRACKED_BYTES / 1024 / 1024;
        ctx.ui.notify(`Checkpoints skip untracked files over ${mib} MiB, so /rewind can't restore: ${fresh.slice(0, 3).join(", ")}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ""}`, "warning");
      }
      return r.tree;
    } catch (e) {
      disable(ctx, (e as Error).message);
      return undefined;
    }
  }

  /** Pi saves the user message after `message_end`, so its start entry is written on the next event. */
  function flush(ctx: ExtensionContext) {
    if (!pending) return;
    const p = pending;
    const branch = ctx.sessionManager.getBranch() as Entry[];
    for (let i = branch.length - 1; i >= 0; i--) {
      const e = branch[i]!;
      if (e.type === "message" && e.message?.role === "user" && e.message.timestamp === p.timestamp) {
        pending = undefined;
        pi.appendEntry(CHECKPOINT_ENTRY, { kind: "start", user: e.id, tree: p.tree });
        return;
      }
    }
  }

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "user") return;
    flush(ctx);
    const tree = await capture(ctx);
    if (tree) pending = { timestamp: event.message.timestamp, tree };
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "user") flush(ctx);
  });

  pi.on("agent_start", () => {
    running = true;
  });

  pi.on("agent_end", async (_event, ctx) => {
    running = false;
    flush(ctx);
    pending = undefined;
    const tree = await capture(ctx);
    if (tree) pi.appendEntry(CHECKPOINT_ENTRY, { kind: "end", tree });
  });

  /**
   * The path from the root to an entry, plus any `end` checkpoints hanging
   * directly below it: a run's `end` sits after its final message, and Pi's
   * leaf is that message after a /tree move.
   */
  function pathTo(ctx: ExtensionContext, leaf: string | null): Entry[] {
    if (!leaf) return [];
    const all = ctx.sessionManager.getEntries() as Entry[];
    const out = [...(ctx.sessionManager.getBranch(leaf) as Entry[])];
    for (;;) {
      const leaf = out.at(-1);
      const next = all.filter((e) => e.parentId === (leaf?.id ?? null) && e.type === "custom" && e.customType === CHECKPOINT_ENTRY && (e.data as { kind?: string })?.kind === "end").at(-1);
      if (!next) return out;
      out.push(next);
    }
  }

  async function changesOf(segs: Segment[], current: string): Promise<Change[]> {
    const s = store!;
    return Promise.all(segs.map(async (segment) => ({ segment, files: segment.after || segment === segs.at(-1) ? await s.changedFiles(segment.before, segment.after ?? current) : [] })));
  }

  /** What restoring the files from `from` to `to` would do, against the files as they are now. */
  async function prepare(ctx: ExtensionContext, from: Entry[], to: Entry[]): Promise<Prepared | undefined> {
    const current = await capture(ctx);
    if (!current || !store) return undefined;
    const { undo, redo } = diffPaths(from, to);
    // Only the newest undone segment can be open (a run that crashed before its `end`): it runs to now.
    const plan = planRestore(await changesOf(undo, current), (await changesOf(redo, current)).filter((c) => c.segment.after));
    const files = new Map<string, string>();
    const conflicts = new Set<string>();
    let added = 0;
    let deleted = 0;
    for (const [tree, paths] of group(plan.files)) {
      const stats = await store.stats(current, tree);
      for (const p of paths) {
        const st = stats.get(p);
        if (!st) continue; // already as it was
        files.set(p, tree);
        added += st.added;
        deleted += st.deleted;
      }
    }
    for (const [tree, paths] of group(plan.expected)) {
      const edited = new Set(await store.changedFiles(tree, current));
      for (const p of paths) if (files.has(p) && edited.has(p)) conflicts.add(p);
    }
    return { current, files, conflicts: [...conflicts].sort(), added, deleted };
  }

  /** Asks about files edited after the agent, then restores. Returns the number restored, or undefined when the user cancels. */
  async function apply(ctx: ExtensionContext, prep: Prepared, leaf?: string | null): Promise<number | undefined> {
    let files = prep.files;
    if (prep.conflicts.length) {
      const all = `Restore them too (you can undo with /rewind)`;
      const skip = `Keep their current content`;
      const choice = await ctx.ui.select(
        `${prep.conflicts.length} of these files changed after the agent's last edit, probably by you:\n${list(prep.conflicts)}`,
        [all, skip, "Cancel"],
      );
      if (choice === skip) files = new Map([...files].filter(([p]) => !prep.conflicts.includes(p)));
      else if (choice !== all) return undefined;
    }
    if (!files.size) return 0;
    await store!.restore(files);
    pi.appendEntry<RewindData>(REWIND_ENTRY, { safety: prep.current, files: [...files.keys()], ...(leaf !== undefined ? { leaf } : {}) });
    return files.size;
  }

  const restored = (n: number) => `Restored ${n} file${n === 1 ? "" : "s"}; /rewind can undo it.`;

  function summary(prep: Prepared): string {
    const n = prep.files.size;
    return `${n} file${n === 1 ? "" : "s"} (+${prep.added} −${prep.deleted}):\n${list([...prep.files.keys()])}`;
  }

  function busy(ctx: ExtensionContext): boolean {
    if (!store) {
      ctx.ui.notify("Checkpoints are off for this session.", "warning");
      return true;
    }
    if (running || !ctx.isIdle()) {
      ctx.ui.notify("Wait for the agent to finish (or press Escape) before rewinding.", "warning");
      return true;
    }
    // Subagents and background jobs write to the same files; a restore now would race them.
    if (currentHub()?.busy()) {
      ctx.ui.notify("Subagents or background jobs are still working; wait for them or stop them (↓ on an empty prompt) before rewinding.", "warning");
      return true;
    }
    return false;
  }

  pi.registerCommand("rewind", {
    description: "Go back to before one of your messages: restore code, conversation, or both",
    handler: async (_args, ctx) => {
      if (busy(ctx)) return;
      const branch = pathTo(ctx, ctx.sessionManager.getLeafId());
      const users = branch.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "message" && e.message?.role === "user").reverse();
      const lastRewind = (ctx.sessionManager.getEntries() as Entry[]).filter((e) => e.type === "custom" && e.customType === REWIND_ENTRY).at(-1);
      const segs = new Map(segments(branch).map((s) => [s.user, s]));
      const current = await capture(ctx);
      if (!current) return;
      const changes = await changesOf(segments(branch), current);
      const touched = (fromUser: number) => {
        const files = new Set<string>();
        for (const c of changes) if (branch.findIndex((e) => e.id === c.segment.user) >= fromUser) for (const f of c.files) files.add(f);
        return files.size;
      };

      const undoLabel = lastRewind && `↶ ${(lastRewind.data as RewindData).undoes ? "Redo" : "Undo"} the last file rewind (${(lastRewind.data as RewindData).files.length} files)`;
      const labels = users.map(({ e, i }) => {
        const n = touched(i);
        const files = !segs.has(e.id) ? "no checkpoint" : n ? `${n} file${n === 1 ? "" : "s"} changed since` : "no file changes since";
        return `${preview(e.message?.content)}  · ${files}`;
      });
      if (!labels.length && !undoLabel) {
        ctx.ui.notify("Nothing to rewind yet.", "info");
        return;
      }
      const pick = await ctx.ui.select("Rewind to before which message?", [...(undoLabel ? [undoLabel] : []), ...labels]);
      if (!pick) return;
      if (pick === undoLabel) return undoRewind(ctx, lastRewind!);

      const { e: target, i } = users[labels.indexOf(pick)]!;
      const prep = await prepare(ctx, branch, branch.slice(0, i));
      if (!prep) return;
      const both = "Restore code and conversation";
      const convo = "Restore conversation only";
      const code = "Restore code only";
      const options = prep.files.size ? [both, convo, code, "Cancel"] : [convo, "Cancel"];
      const title = prep.files.size ? `The agent changed ${summary(prep)}` : "The agent changed no files since this message.";
      const choice = await ctx.ui.select(title, options);
      if (choice !== both && choice !== code && choice !== convo) return;
      let n = 0;
      if (choice !== convo) {
        const r = await apply(ctx, prep, choice === both ? ctx.sessionManager.getLeafId() : undefined);
        if (r === undefined) return;
        n = r;
      }
      if (choice !== code) await navigate(ctx as ExtensionCommandContext, target.id);
      if (n) ctx.ui.notify(restored(n), "info");
    },
  });

  async function navigate(ctx: ExtensionCommandContext, id: string) {
    navigating = true;
    try {
      await ctx.navigateTree(id);
    } finally {
      navigating = false;
    }
  }

  /** Puts the files back as they were before the last rewind and, if it moved the conversation, moves that back too. Undoing an undo redoes. */
  async function undoRewind(ctx: ExtensionCommandContext, entry: Entry) {
    const data = entry.data as RewindData;
    const current = await capture(ctx);
    if (!current || !store) return;
    const files = new Map(data.files.map((p) => [p, data.safety]));
    await store.restore(files);
    const moved = data.leaf !== undefined;
    const here = ctx.sessionManager.getLeafId();
    pi.appendEntry<RewindData>(REWIND_ENTRY, { safety: current, files: data.files, undoes: entry.id, ...(moved ? { leaf: here } : {}) });
    if (moved && data.leaf) await navigate(ctx, data.leaf);
    ctx.ui.notify(`Put back ${files.size} file${files.size === 1 ? "" : "s"}${moved ? " and the conversation" : ""} as before the rewind.`, "info");
  }

  /** Pi's /tree (and Escape twice on an empty prompt) only moves the conversation; offer the files too. */
  pi.on("session_before_tree", async (event, ctx) => {
    if (navigating || running || !store || !ctx.hasUI || currentHub()?.busy()) return;
    const { targetId, oldLeafId } = event.preparation;
    const target = ctx.sessionManager.getEntry(targetId) as Entry | undefined;
    if (!target) return;
    const leaf = (target.type === "message" && target.message?.role === "user") || target.type === "custom_message" ? target.parentId : target.id;
    notice = undefined;
    await offer(ctx, oldLeafId, leaf, "Also restore files to this point?");
  });

  pi.on("session_before_fork", async (event, ctx) => {
    if (running || !store || !ctx.hasUI || currentHub()?.busy()) return;
    const target = ctx.sessionManager.getEntry(event.entryId) as Entry | undefined;
    if (!target) return;
    const leaf = event.position === "before" ? target.parentId : target.id;
    await offer(ctx, ctx.sessionManager.getLeafId(), leaf, "Also restore files to this point? The fork shares this folder with the current session.");
    // No session_tree follows a fork.
    if (notice) ctx.ui.notify(notice, "info");
    notice = undefined;
  });

  async function offer(ctx: ExtensionContext, fromLeaf: string | null, toLeaf: string | null, question: string) {
    const from = pathTo(ctx, fromLeaf);
    const to = pathTo(ctx, toLeaf);
    const prep = await prepare(ctx, from, to);
    if (!prep?.files.size) return;
    const keep = "Keep the current files";
    const restore = "Restore the files";
    const choice = await ctx.ui.select(`${question}\nThe agent changed ${summary(prep)}`, [keep, restore]);
    if (choice !== restore) return;
    const n = await apply(ctx, prep);
    // Pi's "Navigated to selected point" would replace a notice shown now.
    if (n) notice = restored(n);
  }

  let notice: string | undefined;
  pi.on("session_tree", (_event, ctx) => {
    const text = notice;
    notice = undefined;
    // Pi clears and redraws the chat right after this event; show the notice after that.
    if (text) setTimeout(() => ctx.ui.notify(text, "info"), 0);
  });
}

function group(m: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [p, t] of m) out.set(t, [...(out.get(t) ?? []), p]);
  return out;
}

function list(paths: string[]): string {
  const shown = paths.slice(0, 8).map((p) => `  ${p}`);
  return [...shown, ...(paths.length > 8 ? [`  and ${paths.length - 8} more`] : [])].join("\n");
}

function preview(content: unknown): string {
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === "text" ? c.text : "[image]")).join(" ") : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? line.slice(0, 59) + "…" : line || "(empty)";
}
