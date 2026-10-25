/**
 * The bundled themes (`themes/*.json`, loaded through Pi's theme mechanism
 * from `resources_discover`) and the `/theme` picker with live preview.
 */
import { DynamicBorder, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SelectList } from "@earendil-works/pi-tui";

export const DEFAULT_THEME = "b4agent";

/** The bundled pack in display order; other themes (Pi's, the user's) sort alphabetically after it. */
export const CURATED: ReadonlyArray<readonly [name: string, blurb: string]> = [
  ["b4agent", "IBM Carbon blues (default)"],
  ["Dark", "charcoal + muted pastels"],
  ["Midnight", "inky slate-blue night"],
  ["tokyo-night", "neon Tokyo after dark"],
  ["tokyo-night-storm", "Tokyo Night, storm-blue wash"],
  ["catppuccin-mocha", "soothing pastels, darkest roast"],
  ["catppuccin-macchiato", "soothing pastels, medium roast"],
  ["catppuccin-frappe", "soothing pastels, light roast"],
  ["catppuccin-latte", "soothing pastels, light theme"],
  ["dracula", "it rhymes with spectacular"],
  ["rose-pine", "muted rose, iris and pine"],
  ["everforest", "warm green forest comfort"],
  ["monokai", "classic Monokai warmth"],
  ["gruvbox", "retro groove, warm earth"],
  ["nord", "arctic north-bluish frost"],
  ["one-dark", "Atom One Dark classic"],
  ["ayu", "deep ink and amber"],
  ["kanagawa", "the Great Wave, muted ink"],
  ["matrix", "wake up, Neo"],
];

const ORDER = new Map(CURATED.map(([name], i) => [name, i]));
const BLURBS = new Map<string, string>([...CURATED, ["system", "Pi built-in, your terminal's colors"], ["dark", "Pi built-in"], ["light", "Pi built-in, light"]]);

export function orderThemes(names: readonly string[]): string[] {
  return [...new Set(names)].sort((a, b) => (ORDER.get(a) ?? Infinity) - (ORDER.get(b) ?? Infinity) || a.localeCompare(b));
}

/** A list of themes; moving the highlight previews, Enter picks, Esc cancels. */
export class ThemePicker extends Container {
  private readonly list: SelectList;

  constructor(names: string[], current: string | undefined, done: (choice: string | undefined) => void, preview: (name: string) => void) {
    super();
    const items = names.map((name) => ({
      value: name,
      label: name,
      description: [BLURBS.get(name), name === current ? "(current)" : undefined].filter(Boolean).join("  "),
    }));
    this.addChild(new DynamicBorder());
    this.list = new SelectList(items, Math.min(12, items.length), getSelectListTheme(), { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 32 });
    const at = current ? names.indexOf(current) : -1;
    if (at >= 0) this.list.setSelectedIndex(at);
    this.list.onSelect = (item) => done(item.value);
    this.list.onCancel = () => done(undefined);
    this.list.onSelectionChange = (item) => preview(item.value);
    this.addChild(this.list);
    this.addChild(new DynamicBorder());
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }
}
