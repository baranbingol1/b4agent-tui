import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCollapsedSteps } from "../tui/collapse.js";
import { installHighlightReference } from "../tui/reference.js";

/** Main-transcript TUI features: collapsed agent steps (plan section 25) and highlight-to-reference (section 24). */
export default function steps(pi: ExtensionAPI) {
  let offs: (() => void)[] = [];
  const off = () => {
    for (const f of offs) f();
    offs = [];
  };
  pi.on("session_start", (_e, ctx) => {
    off();
    if (ctx.hasUI && ctx.mode === "tui") offs = [installCollapsedSteps(ctx.ui), installHighlightReference(ctx.ui)];
  });
  pi.on("session_shutdown", off);
}
