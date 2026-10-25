import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SavedRecap } from "./trigger.js";

export const RECAP_LABEL = "✦ recap";

/** The recap above the editor: dim, labelled, wrapped to the width, the `Next:` line indented under the text. */
export function recapLines(r: Pick<SavedRecap, "text" | "next">, width: number, theme: Pick<Theme, "fg" | "bold">): string[] {
  const indent = " ".repeat(RECAP_LABEL.length + 1);
  const room = Math.max(10, width - indent.length - 1);
  const out: string[] = [];
  wrapTextWithAnsi(r.text, room).forEach((l, i) => out.push(i === 0 ? `${theme.fg("dim", theme.bold(RECAP_LABEL))} ${theme.fg("dim", l)}` : `${indent}${theme.fg("dim", l)}`));
  if (r.next) for (const l of wrapTextWithAnsi(`Next: ${r.next}`, room)) out.push(`${indent}${theme.fg("dim", l)}`);
  return out;
}
