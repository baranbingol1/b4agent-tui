import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { RecapController, type RecapHost } from "../../src/recap/controller.js";
import { clip, parseRecap, smallInput } from "../../src/recap/generate.js";
import { isPresence, loadRecapSettings, readConversation, recapBlocker, RECAP_ENTRY, type SavedRecap } from "../../src/recap/trigger.js";
import type { Generated } from "../../src/recap/generate.js";

let n = 0;
const msg = (role: string, stopReason?: string): SessionEntry =>
  ({ type: "message", id: `e${++n}`, parentId: null, timestamp: "", message: { role, content: [{ type: "text", text: `${role} ${n}` }], ...(stopReason ? { stopReason } : {}) } }) as unknown as SessionEntry;
const custom = (customType: string, data: unknown = {}): SessionEntry => ({ type: "custom", id: `e${++n}`, parentId: null, timestamp: "", customType, data }) as unknown as SessionEntry;
const turn = (stop = "stop") => [msg("user"), msg("assistant", "toolUse"), msg("toolResult"), msg("assistant", stop)];

describe("which turns count", () => {
  it("counts completed turns, not aborted or failed ones, and turns since the last recap", () => {
    const branch = [...turn(), ...turn("aborted"), ...turn(), ...turn("error"), ...turn()];
    expect(readConversation(branch)).toMatchObject({ turns: 3, turnsSinceRecap: 3 });
    const withRecap = [...branch, custom(RECAP_ENTRY, { text: "x", leafId: "?" }), custom("checkpoint")];
    const c = readConversation(withRecap);
    expect(c).toMatchObject({ turns: 3, turnsSinceRecap: 0, lastRecap: { text: "x" } });
    // Custom entries move Pi's leaf but not the conversation's.
    expect(c.leafId).toBe(branch.at(-1)!.id);
    expect(readConversation([...withRecap, ...turn()])).toMatchObject({ turns: 4, turnsSinceRecap: 1 });
  });

  it("blocks with fewer than 3 turns, no new turn, a draft, or a busy agent", () => {
    const ok = { conversation: { turns: 3, turnsSinceRecap: 1, leafId: "a" }, draft: "", idle: true };
    expect(recapBlocker(ok, { minTurns: 3 })).toBeUndefined();
    expect(recapBlocker({ ...ok, conversation: { ...ok.conversation, turns: 2 } }, { minTurns: 3 })).toMatch(/fewer than 3/);
    expect(recapBlocker({ ...ok, conversation: { ...ok.conversation, turnsSinceRecap: 0 } }, { minTurns: 3 })).toMatch(/no new turn/);
    expect(recapBlocker({ ...ok, draft: "  half a thought" }, { minTurns: 3 })).toMatch(/draft/);
    expect(recapBlocker({ ...ok, draft: "  \n" }, { minTurns: 3 })).toBeUndefined();
    expect(recapBlocker({ ...ok, idle: false }, { minTurns: 3 })).toMatch(/busy/);
  });

  it("treats keys and clicks as presence, not focus reports or bare mouse motion", () => {
    expect(isPresence("a")).toBe(true);
    expect(isPresence("\x1b[A")).toBe(true);
    expect(isPresence("\x1b[<0;10;5M")).toBe(true); // click
    expect(isPresence("\x1b[<64;10;5M")).toBe(true); // wheel
    expect(isPresence("\x1b[<35;10;5M")).toBe(false); // motion, no button
    expect(isPresence("\x1b[<32;10;5M")).toBe(true); // drag with the left button
    expect(isPresence("\x1b[I")).toBe(false);
    expect(isPresence("\x1b[O")).toBe(false);
  });

  it("reads the away threshold from b4agent.json, and the environment wins", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4-recap-"));
    const path = join(dir, "b4agent.json");
    writeFileSync(path, JSON.stringify({ recap: { awaySeconds: 90, cacheTtlSeconds: 600, enabled: false } }));
    expect(loadRecapSettings({}, path)).toMatchObject({ awayMs: 90_000, cacheTtlMs: 600_000, enabled: false, minTurns: 3 });
    expect(loadRecapSettings({ B4AGENT_RECAP_AWAY_SECONDS: "2.5" }, path).awayMs).toBe(2500);
    const errors: string[] = [];
    expect(loadRecapSettings({ B4AGENT_RECAP_AWAY_SECONDS: "soon" }, path, errors).awayMs).toBe(90_000);
    expect(errors).toHaveLength(1);
    expect(loadRecapSettings({}, join(dir, "missing.json")).awayMs).toBe(180_000);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the recap text", () => {
  it("takes line 1 and an optional Next: line, without markdown or labels", () => {
    expect(parseRecap("**Recap:** Fixing the flaky login test; the retry is in, CI is green.\n\n- Next: merge the PR?")).toEqual({
      text: "Fixing the flaky login test; the retry is in, CI is green.",
      next: "merge the PR?",
    });
    expect(parseRecap("Only one line.")).toEqual({ text: "Only one line." });
    expect(parseRecap("\n  \n")).toBeUndefined();
    const long = parseRecap("word ".repeat(80))!;
    expect(long.text.length).toBeLessThanOrEqual(200);
    expect(long.text.endsWith("…")).toBe(true);
    expect(clip("a b c", 10)).toBe("a b c");
  });

  it("gives the small model the first request, the previous recap, the last user message and the last reply, never tool output", () => {
    const u = (t: string) => ({ role: "user", content: [{ type: "text", text: t }] });
    const a = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" });
    const tool = { role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "SECRET TOOL OUTPUT" }] };
    const input = smallInput([u("port the parser to Rust"), a("started"), u("x".repeat(3000)), tool, a(`${"y".repeat(3000)}END`)] as never[], { text: "Porting the parser", leafId: "a", model: "m" });
    expect(input).toContain("<first_request>\nport the parser to Rust");
    expect(input).toContain("<previous_recap>\nPorting the parser");
    expect(input).not.toContain("SECRET TOOL OUTPUT");
    expect(input.match(/<last_user_message>\n(x+)…/)![1]).toHaveLength(1000);
    expect(input.match(/<last_agent_reply>\n…([y]+END)/)![1]).toHaveLength(1500);
  });
});

/** A fake clock with timers, a session whose entries the test edits, and a model call the test resolves. */
function harness(o: { turns?: number; draft?: string } = {}) {
  let t = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  const branch: SessionEntry[] = Array.from({ length: o.turns ?? 3 }, () => turn()).flat();
  const state = { draft: o.draft ?? "", idle: true };
  const shown: (SavedRecap | undefined)[] = [];
  const saved: SavedRecap[] = [];
  const statuses: (string | undefined)[] = [];
  const calls: { signal: AbortSignal; resolve: (g: Generated) => void; reject: (e: Error) => void }[] = [];
  const host: RecapHost = {
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn, id: ++id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
    conversation: () => readConversation(branch),
    draft: () => state.draft,
    idle: () => state.idle,
    generate: (_c, signal) =>
      new Promise<Generated>((resolve, reject) => {
        calls.push({ signal, resolve, reject });
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    show: (r) => shown.push(r),
    status: (s) => statuses.push(s),
    save: (r) => {
      saved.push(r);
      branch.push(custom(RECAP_ENTRY, r));
    },
  };
  const c = new RecapController(host, { awayMs: 180_000, minTurns: 3 });
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      // Let settled promises run first: they may set new timers.
      await new Promise((r) => setTimeout(r, 0));
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      t = next.at;
      next.fn();
    }
    t = end;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { c, branch, state, shown, saved, statuses, calls, advance, flush, timers };
}

const recap: Generated = { text: "Porting the parser; tests pass.", next: "benchmark it?", model: "faux/m", route: "main" };

describe("away mode", () => {
  it("generates after 3 minutes without keystrokes, counted from the later of the last key and the settle", async () => {
    const h = harness();
    await h.advance(60_000);
    h.c.input("a"); // typed at 1 min, then sent
    await h.advance(60_000);
    h.c.settled(false); // the run settles at 2 min
    await h.advance(179_000);
    expect(h.calls).toHaveLength(0);
    await h.advance(1_000);
    expect(h.calls).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("recap…");
    h.calls[0]!.resolve(recap);
    await h.flush();
    expect(h.statuses.at(-1)).toBeUndefined();
    expect(h.saved).toEqual([{ ...recap, leafId: h.branch.at(-2)!.id }]);
    expect(h.shown.at(-1)).toMatchObject({ text: recap.text });
    expect(h.c.visible).toBeDefined();
  });

  it("keystrokes push the away point back; focus reports and mouse motion don't", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(170_000);
    h.c.input("\x1b[I");
    h.c.input("\x1b[<35;3;3M");
    await h.advance(10_000);
    expect(h.calls).toHaveLength(1);
    const g = harness();
    g.c.settled(false);
    await g.advance(170_000);
    g.c.input("x");
    await g.advance(10_000);
    expect(g.calls).toHaveLength(0);
    await g.advance(170_000);
    expect(g.calls).toHaveLength(1);
  });

  it("needs 3 completed turns, a clean settle, an empty editor and an idle agent", async () => {
    for (const [h, why] of [
      [harness({ turns: 2 }), "two turns"],
      [harness({ draft: "wip" }), "a draft"],
    ] as const) {
      h.c.settled(false);
      await h.advance(200_000);
      expect(h.calls, why).toHaveLength(0);
    }
    const aborted = harness();
    aborted.c.settled(true);
    await aborted.advance(200_000);
    expect(aborted.calls).toHaveLength(0);
    const busy = harness();
    busy.state.idle = false;
    busy.c.settled(false);
    await busy.advance(200_000);
    expect(busy.calls).toHaveLength(0);
  });

  it("never runs twice in a row: a new turn is needed after a recap", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    h.calls[0]!.resolve(recap);
    await h.flush();
    // Back, a glance, away again without a turn: nothing new.
    h.c.input("\x1b[A");
    h.c.settled(false);
    await h.advance(400_000);
    expect(h.calls).toHaveLength(1);
    // A new turn, then away again: a second recap.
    h.branch.push(...turn());
    h.c.agentStart();
    h.c.settled(false);
    await h.advance(180_000);
    expect(h.calls).toHaveLength(2);
  });

  it("a keystroke cancels a recap in flight, and it is written again on the next away", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    const first = h.calls[0]!;
    h.c.input("h");
    expect(first.signal.aborted).toBe(true);
    expect(h.statuses.at(-1)).toBeUndefined();
    first.resolve(recap); // too late: ignored
    await h.flush();
    expect(h.saved).toHaveLength(0);
    expect(h.shown).toHaveLength(0);
    await h.advance(180_000);
    expect(h.calls).toHaveLength(2);
  });

  it("agent_start cancels a recap in flight and doesn't re-arm", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    h.c.agentStart();
    expect(h.calls[0]!.signal.aborted).toBe(true);
    await h.advance(600_000);
    expect(h.calls).toHaveLength(1);
    expect(h.saved).toHaveLength(0);
  });

  it("drops a recap whose leaf changed while it was written", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    // A scheduled prompt or another client appended to the conversation without a keystroke here.
    h.branch.push(msg("user"));
    h.calls[0]!.resolve(recap);
    await h.flush();
    expect(h.saved).toHaveLength(0);
    expect(h.shown).toHaveLength(0);
  });

  it("keeps a recap when only custom entries were added meanwhile", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    h.branch.push(custom("checkpoint"));
    h.calls[0]!.resolve(recap);
    await h.flush();
    expect(h.saved).toHaveLength(1);
  });

  it("hides on typing (once the editor has text) or on send, not on navigation keys", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    h.calls[0]!.resolve(recap);
    await h.flush();
    h.c.input("\x1b[B");
    await h.advance(0);
    expect(h.c.visible).toBeDefined();
    h.state.draft = "w";
    h.c.input("w");
    await h.advance(0);
    expect(h.c.visible).toBeUndefined();
    expect(h.shown.at(-1)).toBeUndefined();
    const s = harness();
    s.c.settled(false);
    await s.advance(180_000);
    s.calls[0]!.resolve(recap);
    await s.flush();
    s.c.sent();
    expect(s.c.visible).toBeUndefined();
  });

  it("on resume shows the saved recap if its leaf matches, and otherwise writes one right away", async () => {
    const h = harness();
    const leaf = h.branch.at(-1)!.id;
    h.branch.push(custom(RECAP_ENTRY, { text: "saved one", leafId: leaf, model: "m" }), custom("checkpoint"));
    h.c.sessionStart("resume");
    expect(h.shown.at(-1)).toMatchObject({ text: "saved one" });
    expect(h.calls).toHaveLength(0);

    const g = harness();
    g.branch.push(custom(RECAP_ENTRY, { text: "old", leafId: g.branch.at(-1)!.id, model: "m" }), ...turn());
    g.c.sessionStart("fork");
    expect(g.calls).toHaveLength(1);
    g.calls[0]!.resolve(recap);
    await g.flush();
    expect(g.shown.at(-1)).toMatchObject({ text: recap.text });

    const fresh = harness({ turns: 0 });
    fresh.c.sessionStart("startup");
    const reload = harness();
    reload.c.sessionStart("reload");
    expect(fresh.calls.length + reload.calls.length).toBe(0);
  });

  it("a failed recap waits for the next turn instead of retrying", async () => {
    const h = harness();
    h.c.settled(false);
    await h.advance(180_000);
    h.calls[0]!.reject(new Error("boom"));
    await h.flush();
    expect(h.statuses.at(-1)).toBeUndefined();
    await h.advance(600_000);
    expect(h.calls).toHaveLength(1);
  });
});
