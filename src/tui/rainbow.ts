import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { Theme } from "@earendil-works/pi-coding-agent";
import { foregroundAnsi, getTerminalColorMode, okhslColor, type TerminalColorMode } from "@earendil-works/pi-tui";

/**
 * The model's top reasoning level gets a rainbow prompt border, as Claude
 * Code does for its highest effort. "Top" is per model: `max` where the model
 * has it, otherwise `xhigh`, otherwise `high`. Lower levels keep the theme's
 * colours.
 */

/** Columns per full hue turn. */
const PERIOD = 48;
const ansiCache = new Map<string, string>();

function hueAnsi(column: number, mode: TerminalColorMode): string {
  const step = ((column % PERIOD) + PERIOD) % PERIOD;
  const key = `${mode}:${step}`;
  let a = ansiCache.get(key);
  if (a === undefined) {
    a = foregroundAnsi(okhslColor((step * 360) / PERIOD, 0.85, 0.72), mode);
    ansiCache.set(key, a);
  }
  return a;
}

/**
 * Colours each character by its column. Pi draws the editor's border in
 * pieces (around the spinner and the "more lines" label), so the column
 * carries over from one call to the next and the gradient stays continuous;
 * it restarts at `start` (0 for a new line).
 */
export function rainbow(text: string, start = 0, mode: TerminalColorMode = getTerminalColorMode()): string {
  let out = "";
  let col = start;
  for (const ch of text) {
    out += ch === " " ? ch : hueAnsi(col, mode) + ch;
    col++;
  }
  return out + "\x1b[39m";
}

/** The highest level the model supports; undefined when it has no reasoning levels. */
export function topLevel(model: Pick<Model<Api>, "reasoning" | "thinkingLevelMap"> | undefined): string | undefined {
  if (!model?.reasoning) return undefined;
  const levels = getSupportedThinkingLevels(model as Model<Api>);
  const top = levels[levels.length - 1];
  return top && top !== "off" ? top : undefined;
}

let current: string | undefined;
let installed = false;

/** Tell the border which level is the current model's top. */
export function setTopLevel(level: string | undefined): void {
  current = level;
}

/**
 * Wraps Theme.getThinkingBorderColor (public on Pi 1.3.0's exported Theme).
 * The returned function checks the level at call time, so a model switch
 * takes effect on the next render whichever order Pi and we handle it in.
 */
export function installRainbowBorder(): void {
  if (installed) return;
  installed = true;
  const original = Theme.prototype.getThinkingBorderColor;
  Theme.prototype.getThinkingBorderColor = function (this: Theme, level) {
    const plain = original.call(this, level);
    let col = 0;
    return (str: string) => {
      if (level !== current) return plain(str);
      // Pi renders a frame synchronously, so a microtask marks its end: the next frame starts at column 0.
      if (col === 0) queueMicrotask(() => (col = 0));
      const out = rainbow(str, col, this.getColorMode());
      col += [...str].length;
      return out;
    };
  };
}
