import { describe, expect, it } from "vitest";
import { route, type Mode } from "../../src/permissions/gate.js";
import { applyHookDecision, type HookDecision } from "../../src/permissions/hooks.js";
import type { Level, Verdict } from "../../src/permissions/types.js";

const v = (level: Level, rule = "r"): Verdict => ({ level, rule, reason: "why" });
const allowG: HookDecision = { decision: "allow", reason: "hook ok", source: "global" };
const allowP: HookDecision = { ...allowG, source: "project" };
const ask: HookDecision = { decision: "ask", reason: "hook asks", source: "project" };

/** Where a call goes after a hook's allow or ask, per mode. Hook denies never reach the gate. */
describe("hook decisions at the gate", () => {
  it.each<[Level, HookDecision | undefined, Mode, string]>([
    // A hard deny holds whatever the hook says, in every mode.
    ["deny", allowG, "yolo", "block"],
    ["deny", ask, "manual", "block"],
    // Always-ask rules (protected paths, credentials, publishing) still reach the user after a hook allow.
    ["ask", allowG, "auto", "user"],
    ["ask", allowG, "manual", "user"],
    // A global hook allow skips the reviewer and manual mode's prompt.
    ["review", allowG, "auto", "run"],
    ["review", allowG, "manual", "run"],
    ["auto", allowG, "manual", "run"],
    // A project hook can't add allow rules (plan sections 0 and 1).
    ["review", allowP, "auto", "reviewer"],
    ["auto", allowP, "manual", "user"],
    // Ask forces the user even for read-only calls and for calls the reviewer would clear; YOLO runs it like any ask.
    ["allow", ask, "auto", "user"],
    ["review", ask, "auto", "user"],
    ["allow", ask, "yolo", "run"],
    // No hook: unchanged.
    ["review", undefined, "auto", "reviewer"],
  ])("%s + %j in %s → %s", (level, hook, mode, want) => {
    expect(route(applyHookDecision(v(level), hook).level, mode)).toBe(want);
  });

  it("says why in the verdict the dialog and the log show", () => {
    expect(applyHookDecision(v("review"), ask)).toMatchObject({ level: "ask", rule: "hook-ask", reason: expect.stringContaining("hook asks") });
    expect(applyHookDecision(v("ask"), ask).reason).toBe("why; a hook also asks: hook asks");
    expect(applyHookDecision({ ...v("review"), targets: ["/x"] }, allowG)).toMatchObject({ rule: "hook-allow", targets: ["/x"] });
  });
});
