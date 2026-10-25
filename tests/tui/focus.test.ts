import { afterEach, describe, expect, it } from "vitest";
import { focusState, handleRawInput, isAway, isUserInput, lastFocusReport, lastInputAt, onAwayChange, onFocusChange, resetFocusForTests } from "../../src/tui/focus.js";
import { shouldRing } from "../../src/tui/notify.js";

afterEach(resetFocusForTests);

describe("focus tracking", () => {
  it("follows focus-out and focus-in reports", () => {
    const away: boolean[] = [];
    onAwayChange((a) => away.push(a));
    expect(focusState()).toBe("unknown");
    handleRawInput("\x1b[O", 1);
    expect(isAway()).toBe(true);
    handleRawInput("\x1b[I", 2);
    expect(focusState()).toBe("focused");
    expect(away).toEqual([true, false]);
  });

  it("puts a report split across chunks back together (a pty may deliver it byte by byte)", () => {
    handleRawInput("\x1b", 10);
    handleRawInput("[", 11);
    handleRawInput("O", 12);
    expect(isAway()).toBe(true);
  });

  it("doesn't join an Esc key with typing much later", () => {
    handleRawInput("\x1b", 10);
    handleRawInput("[O", 500);
    expect(focusState()).toBe("unknown");
  });

  it("counts a key as coming back even when the focus-in report got lost", () => {
    const states: string[] = [];
    onFocusChange((s) => states.push(s));
    handleRawInput("\x1b[O", 1);
    handleRawInput("x", 2);
    expect(states).toEqual(["blurred", "focused"]);
    expect(lastInputAt()).toBe(2);
  });

  it("takes the last report in a chunk", () => {
    expect(lastFocusReport("\x1b[O\x1b[I")).toBe("I");
    expect(lastFocusReport("\x1b[I\x1b[O")).toBe("O");
    expect(lastFocusReport("abc")).toBeUndefined();
  });

  it("doesn't count focus reports or bare mouse motion as someone typing", () => {
    expect(isUserInput("\x1b[O")).toBe(false);
    expect(isUserInput("\x1b[<35;10;5M")).toBe(false);
    expect(isUserInput("\x1b[<0;10;5M")).toBe(true);
    expect(isUserInput("\x1b[Oa")).toBe(true);
  });

  it("isolates a throwing listener", () => {
    onAwayChange(() => {
      throw new Error("boom");
    });
    expect(() => handleRawInput("\x1b[O", 1)).not.toThrow();
  });
});

describe("shouldRing", () => {
  const q = { runMs: 60_000, idleMs: 60_000, minMs: 20_000, aborted: false };
  it("rings when the window is unfocused, however short the run", () => {
    expect(shouldRing({ ...q, focus: "blurred", runMs: 100, idleMs: 100 })).toBe(true);
  });
  it("stays quiet when the window is focused, however long the run", () => {
    expect(shouldRing({ ...q, focus: "focused" })).toBe(false);
  });
  it("without focus reports, rings only after a long run with no keys", () => {
    expect(shouldRing({ ...q, focus: "unknown" })).toBe(true);
    expect(shouldRing({ ...q, focus: "unknown", idleMs: 5000 })).toBe(false);
    expect(shouldRing({ ...q, focus: "unknown", runMs: 5000 })).toBe(false);
  });
  it("never rings after Esc", () => {
    expect(shouldRing({ ...q, focus: "blurred", aborted: true })).toBe(false);
  });
});
