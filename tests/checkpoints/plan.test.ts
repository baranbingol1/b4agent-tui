import { describe, expect, it } from "vitest";
import { CHECKPOINT_ENTRY, diffPaths, planRestore, segments, type EntryLike } from "../../src/checkpoints/plan.js";

let n = 0;
const user = (): EntryLike => ({ id: `u${++n}`, type: "message" });
const start = (u: EntryLike, tree: string): EntryLike => ({ id: `s${++n}`, type: "custom", customType: CHECKPOINT_ENTRY, data: { kind: "start", user: u.id, tree } });
const end = (tree: string): EntryLike => ({ id: `e${++n}`, type: "custom", customType: CHECKPOINT_ENTRY, data: { kind: "end", tree } });
const other: EntryLike = { id: "x", type: "custom", customType: "something-else", data: { kind: "end", tree: "ZZ" } };

describe("segments", () => {
  it("ends a segment at the last end before the next start, so your edits between runs stay out of it", () => {
    const u1 = user();
    const u2 = user();
    const s = segments([u1, start(u1, "T0"), end("T1"), other, end("T2"), u2, start(u2, "T3"), end("T4")]);
    expect(s.map((x) => [x.user, x.before, x.after])).toEqual([[u1.id, "T0", "T2"], [u2.id, "T3", "T4"]]);
  });

  it("ends a segment where a steering message starts, and leaves a crashed run open", () => {
    const u1 = user();
    const u2 = user();
    const s = segments([u1, start(u1, "T0"), u2, start(u2, "T1")]);
    expect(s.map((x) => x.after)).toEqual(["T1", undefined]);
  });
});

describe("planRestore", () => {
  const seg = (before: string, after?: string) => ({ user: "u", startId: before, before, ...(after ? { after } : {}) });

  it("puts each file back to before the earliest undone segment that touched it", () => {
    const plan = planRestore([
      { segment: seg("T0", "T1"), files: ["a"] },
      { segment: seg("T2", "T3"), files: ["a", "b"] },
    ]);
    expect([...plan.files]).toEqual([["a", "T0"], ["b", "T2"]]);
    // The file should still look like the agent's latest version of it.
    expect([...plan.expected]).toEqual([["a", "T3"], ["b", "T3"]]);
  });

  it("re-applies the target branch over the undone one", () => {
    const plan = planRestore([{ segment: seg("T0", "T1"), files: ["a", "b"] }], [{ segment: seg("T0", "T9"), files: ["b", "c"] }, { segment: seg("T9"), files: ["d"] }]);
    expect(Object.fromEntries(plan.files)).toEqual({ a: "T0", b: "T9", c: "T9" });
    // b should look like the agent left it on the old branch; c, only touched by the new branch, like the shared base.
    expect(Object.fromEntries(plan.expected)).toEqual({ a: "T1", b: "T1", c: "T0" });
  });
});

describe("diffPaths", () => {
  it("undoes segments only on the old branch and redoes those only on the new one", () => {
    const u1 = user();
    const u2 = user();
    const u3 = user();
    const shared = [u1, start(u1, "T0"), end("T1")];
    const oldBranch = [...shared, u2, start(u2, "T1"), end("T2")];
    const newBranch = [...shared, u3, start(u3, "T1"), end("T5")];
    const { undo, redo } = diffPaths(oldBranch, newBranch);
    expect(undo.map((s) => s.user)).toEqual([u2.id]);
    expect(redo.map((s) => [s.user, s.after])).toEqual([[u3.id, "T5"]]);
    // Going back to before u1 undoes everything.
    expect(diffPaths(oldBranch, []).undo.map((s) => s.user)).toEqual([u1.id, u2.id]);
  });
});
