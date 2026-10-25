import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { cleanTitle, titlePrompt } from "../../src/extension/autotitle.js";
import { detectChecker, filterToTouched } from "../../src/extension/diagnostics.js";
import { detectEnvironment, environmentSection } from "../../src/extension/environment.js";
import { ChangeLog, changesTable, countPatch } from "../../src/tui/changes.js";
import { countLoaded } from "../../src/tui/header.js";
import { parseTuiSettings } from "../../src/tui/settings.js";
import { CHARMS, pacmanFrames, pickWord, WORDS, waveText } from "../../src/tui/spinner.js";

describe("changes", () => {
  const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n ctx";

  it("counts a patch without its headers", () => {
    expect(countPatch(patch)).toEqual({ added: 2, removed: 1 });
  });

  it("rebuilds from a branch: successful edits and writes only, paths relative to cwd", () => {
    const log = new ChangeLog();
    const call = (id: string, name: string, args: object) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] } });
    const result = (id: string, details: object | undefined, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, details, timestamp: 5 } });
    log.rebuild(
      [
        call("1", "edit", { path: "/repo/src/a.ts" }),
        result("1", { patch }),
        call("2", "edit", { path: "/repo/src/a.ts" }),
        result("2", { patch }),
        call("3", "write", { path: "/repo/new.md", content: "x\ny\n" }),
        result("3", undefined),
        call("4", "edit", { path: "/repo/bad.ts" }),
        result("4", { patch }, true),
        call("5", "read", { path: "/repo/src/a.ts" }),
        result("5", undefined),
      ],
      "/repo",
    );
    expect(log.chip()).toBe("Δ2 +6 −2");
    expect(log.snapshot().files.map((f) => f.path).sort()).toEqual(["new.md", "src/a.ts"]);
  });

  it("draws the table latest-first within the width", () => {
    const lines = changesTable({ files: [{ path: "a.ts", added: 2, removed: 1, lastTouched: 1000 }, { path: "b.ts", added: 10, removed: 0, lastTouched: 2000 }], added: 12, removed: 1 }, 60, 62_000);
    expect(lines[0]).toBe("Changes on this branch: 2 files, +12 −1");
    expect(lines[2]).toMatch(/^ {2}\+10 +−0 +b\.ts +1m ago$/);
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(60);
    expect(changesTable({ files: [], added: 0, removed: 0 }, 60, 0)).toEqual(["No files changed on this branch yet."]);
  });
});

describe("spinner", () => {
  it("has the old b4agent word lists", () => {
    expect(WORDS).toHaveLength(85);
    expect(CHARMS).toHaveLength(12);
    expect(WORDS).toContain("Demletiyorum");
  });

  it("draws one 7-cell lane per frame, Pac-Man in every frame", () => {
    const frames = pacmanFrames();
    expect(frames).toHaveLength(30);
    for (const f of frames) {
      const glyph = f.replace(/\x1b\[[0-9;]*m/g, "");
      expect(Array.from(glyph)).toHaveLength(7);
      expect(glyph).toMatch(/[ᗧᗤ○]/);
    }
  });

  it("waves the word without changing its text", () => {
    expect(waveText("Pişiriyorum", 3).replace(/\x1b\[[0-9;]*m/g, "")).toBe("Pişiriyorum… (esc to interrupt)");
  });

  it("never picks the same word twice in a row", () => {
    let last: string | undefined;
    for (let i = 0; i < 200; i++) {
      const w = pickWord(["a", "b", "c"], last);
      expect(w).not.toBe(last);
      last = w;
    }
    expect(pickWord(["only"], "only")).toBe("only");
  });
});

describe("environment section", () => {
  it("is the same text all day (no clock time), so the prompt cache holds", () => {
    const morning = environmentSection(detectEnvironment(new Date("2026-10-21T06:00:00")));
    const evening = environmentSection(detectEnvironment(new Date("2026-10-21T18:30:00")));
    expect(morning).toBe(evening);
    expect(morning).toContain("Date: 2026-10-21");
    expect(morning).not.toMatch(/\d{2}:\d{2}/);
  });
});

describe("autotitle", () => {
  it("cleans a model's reply into a title", () => {
    expect(cleanTitle('"Fix the footer chips."\n')).toBe("Fix the footer chips");
    expect(cleanTitle("Title: Port the theme picker")).toBe("Port the theme picker");
    expect(cleanTitle("\n\n  **Spinner words**  \nextra")).toBe("Spinner words");
    expect(cleanTitle("")).toBe("");
  });
  it("sends a bounded request", () => {
    expect(titlePrompt("x".repeat(10_000)).length).toBeLessThan(4500);
  });
});

describe("diagnostics", () => {
  it("keeps only lines about touched files, and says nothing about other people's breakage", () => {
    const out = "src/a.ts(3,1): error TS1\nsrc/other.ts(1,1): error TS2\n";
    expect(filterToTouched(out, ["/repo/src/a.ts"], "/repo")).toBe("src/a.ts(3,1): error TS1");
    expect(filterToTouched(out, ["/repo/src/b.ts"], "/repo")).toBe("");
    expect(filterToTouched(out, ["/repo/src/b.ts"], "/repo", true)).toBe(out.trim());
  });
  it("picks the project's own tsc only when it is installed and a .ts file was touched", () => {
    const dir = mkdtempSync(join(tmpdir(), "b4diag-"));
    writeFileSync(join(dir, "tsconfig.json"), "{}");
    expect(detectChecker(dir, ["a.ts"])).toBeUndefined();
    mkdirSync(join(dir, "node_modules/.bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.bin/tsc"), "");
    expect(detectChecker(dir, ["a.ts"])?.label).toBe("tsc --noEmit");
    expect(detectChecker(dir, ["a.md"])).toBeUndefined();
    expect(detectChecker(dir, ["a.md"], "make check")).toEqual({ label: "make check", command: "make", args: ["check"] });
  });
});

describe("settings and header", () => {
  it("falls back per key on bad values", () => {
    expect(parseTuiSettings({ spinner: false, notify: { minRunSeconds: -1, bell: false }, diagnostics: { command: " npm test " } })).toEqual({
      spinner: false,
      notify: { bell: false, minRunSeconds: 20 },
      diagnostics: { enabled: true, command: "npm test" },
      autotitle: true,
    });
  });
  it("counts skills and context files in Pi's prompt", () => {
    const prompt = '<available_skills>\n  <skill>\n    <name>a</name>\n  </skill>\n  <skill>\n  </skill>\n</available_skills>\n<project_instructions path="/r/AGENTS.md">';
    expect(countLoaded(prompt)).toEqual({ skills: 2, agentsFiles: 1 });
  });
});

describe("rainbow at the top effort", async () => {
  const { rainbow, topLevel } = await import("../../src/tui/rainbow.js");
  it("picks each model's own top level", () => {
    expect(topLevel({ reasoning: false })).toBeUndefined();
    expect(topLevel({ reasoning: true })).toBe("high");
    expect(topLevel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } as never)).toBe("xhigh");
    expect(topLevel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } as never)).toBe("max");
    // A model that maps max away tops out at xhigh.
    expect(topLevel({ reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: null } } as never)).toBe("xhigh");
  });
  it("keeps the gradient continuous across pieces drawn separately", () => {
    const whole = rainbow("──────", 0, "truecolor");
    const split = rainbow("──", 0, "truecolor") + rainbow("────", 2, "truecolor");
    const colors = (s: string) => [...s.matchAll(/\x1b\[38;[^m]*m/g)].map((m) => m[0]);
    expect(colors(split)).toEqual(colors(whole));
    expect(new Set(colors(whole)).size).toBeGreaterThan(1);
  });
});
