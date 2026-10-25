import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { CURATED, orderThemes } from "../../src/tui/theme.js";

const root = join(import.meta.dirname, "../..");
const dir = join(root, "themes");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

// Pi 1.3's own validator and loader (not exported from the package index, so loaded from its dist files).
type ThemeModule = { setThemeJsonValidator(v: unknown): void; loadThemeFromPath(p: string): { name?: string; fg(c: string, t: string): string } };
let validate: (label: string, json: unknown) => unknown;
let themes: ThemeModule;
beforeAll(async () => {
  const at = (f: string) => pathToFileURL(join(root, "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme", f)).href;
  validate = ((await import(at("theme-schema.js"))) as { validateThemeJson: typeof validate }).validateThemeJson;
  themes = (await import(at("theme.js"))) as ThemeModule;
  themes.setThemeJsonValidator(validate);
});

describe("bundled themes", () => {
  it("ships exactly the curated 19", () => {
    expect(files.map((f) => f.replace(/\.json$/, "")).sort()).toEqual(CURATED.map(([n]) => n).sort());
    expect(files).toHaveLength(19);
  });

  it.each(files)("%s passes Pi 1.3's schema, loads, and is named after its file", (file) => {
    const json = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, unknown>;
    expect(json.$schema).toBe("https://pi.dev/schemas/theme.schema.json");
    expect(json.name).toBe(file.replace(/\.json$/, ""));
    expect(() => validate(file, json)).not.toThrow();
    const theme = themes.loadThemeFromPath(join(dir, file));
    expect(theme.name).toBe(json.name);
    expect(theme.fg("accent", "x")).toContain("x");
  });

  it("a theme with unknown metadata is rejected, so the check above means something", () => {
    const json = JSON.parse(readFileSync(join(dir, "b4agent.json"), "utf8")) as Record<string, unknown>;
    expect(() => validate("bad", { ...json, author: "someone" })).toThrow();
  });
});

describe("orderThemes", () => {
  it("puts the bundled pack first in its order, then the rest alphabetically", () => {
    expect(orderThemes(["light", "dracula", "b4agent", "dark", "zeta", "Dark"])).toEqual(["b4agent", "Dark", "dracula", "dark", "light", "zeta"]);
  });
});
