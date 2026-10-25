import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";

/**
 * Highlight-to-reference (plan section 24, from Amp): select transcript text
 * with the mouse, press `r`, and it is quoted into the prompt box. Fullscreen
 * mode only: there pi-tui owns the selection; in regular mode the terminal
 * does and the app never sees it.
 *
 * `r` is taken only while a selection is active, the prompt editor has the
 * focus and no overlay is open, so typing `r` is otherwise unaffected. The
 * selected text comes from `TuiAltScreen.getActiveSelectionText`, which is
 * TypeScript-private in pi-tui 1.3.0 (`hasActiveSelection` is public and
 * calls it); re-check on a Pi upgrade.
 */
interface Selectable {
  mode?: string;
  hasActiveSelection?: () => boolean;
  getActiveSelectionText?: () => string | undefined;
  resetTextSelection?: () => void;
  hasOverlay?: () => boolean;
  getFocusedComponent?: () => unknown;
  requestRender?: () => void;
}

/** `> ` before every line, blank lines kept as `>`. */
export function quote(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
}

export function installHighlightReference(ui: ExtensionUIContext): () => void {
  let tui: TUI | undefined;
  ui.setWidget("b4agent.reference", (t) => {
    tui = t;
    return { render: () => [], invalidate: () => undefined };
  });
  const off = ui.onTerminalInput((data) => {
    if (isKeyRelease(data) || !matchesKey(data, "r") || !tui) return undefined;
    const t = tui as unknown as Selectable;
    if (t.mode !== "fullscreen" || typeof t.getActiveSelectionText !== "function" || t.hasOverlay?.()) return undefined;
    const focused = t.getFocusedComponent?.() as { getText?: unknown; isShowingAutocomplete?: unknown } | null | undefined;
    if (typeof focused?.getText !== "function" || typeof focused.isShowingAutocomplete !== "function") return undefined;
    const selected = t.getActiveSelectionText()?.trim();
    if (!selected) return undefined;
    const before = ui.getEditorText().trimEnd();
    ui.setEditorText(`${before ? `${before}\n\n` : ""}${quote(selected)}\n\n`);
    t.resetTextSelection?.();
    t.requestRender?.();
    return { consume: true };
  });
  return () => {
    off();
    ui.setWidget("b4agent.reference", undefined);
  };
}
