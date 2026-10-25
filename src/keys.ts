import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";

/**
 * Tab routing (plan sections 7 and 13). The launcher binds Tab to
 * "cycle reasoning effort" and Pi's own Tab action (`tui.input.tab`:
 * autocomplete, picker scope switches) to Shift+Right. That alone would cost
 * Tab everywhere else, so Tab is passed on as Shift+Right whenever it has
 * another job: the editor's autocomplete menu is open, or a picker or dialog
 * has the focus. Only Tab in the plain prompt changes the effort.
 */
const SHIFT_RIGHT = "\x1b[1;2C";

export function installTabRouting(ui: ExtensionUIContext): () => void {
  let tui: TUI | undefined;
  ui.setWidget("b4agent.keys", (t) => {
    tui = t;
    return { render: () => [], invalidate: () => undefined };
  });
  const off = ui.onTerminalInput((data) => {
    if (isKeyRelease(data) || !matchesKey(data, "tab") || !tui) return undefined;
    const focused = (tui as unknown as { getFocusedComponent?: () => unknown }).getFocusedComponent?.() as
      | { getText?: () => string; isShowingAutocomplete?: () => boolean }
      | null
      | undefined;
    const isEditor = typeof focused?.getText === "function" && typeof focused.isShowingAutocomplete === "function";
    if (isEditor && !focused!.isShowingAutocomplete!()) return undefined;
    return { data: SHIFT_RIGHT };
  });
  return () => {
    off();
    ui.setWidget("b4agent.keys", undefined);
  };
}
