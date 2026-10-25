import { AssistantMessageComponent, ToolExecutionComponent, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getKeybindings, isKeyRelease, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { summarizeSteps, type Step } from "./steps.js";

/**
 * Collapsed agent steps in the main transcript (plan section 25, after Amp).
 * Each run of tool calls, with the narration between them, renders as one
 * summary line; the answer after the last call shows in full. Errors stay
 * visible under the line. A running call folds from its first frame (the
 * line reads "Working · now: <step>"), so nothing flashes open and shut.
 *
 * Pi has no grouping hook, so this patches the render methods of Pi's tool
 * and assistant message components (pinned Pi 1.3.0). The view cycles with
 * Pi's tools key (Ctrl+O): grouped, then every step, then every step with
 * full output (Pi's expanded view). In fullscreen mode a click on a summary
 * line opens or closes that one group.
 */

type View = "grouped" | "steps";
let view: View = "grouped";
let installed = false;

interface Group {
  members: Component[];
  tools: ToolLike[];
}

/** The runtime fields of Pi's ToolExecutionComponent this reads (TypeScript-private, present at runtime). */
interface ToolLike extends Component {
  toolName: string;
  args: Record<string, unknown>;
  result?: { isError: boolean; details?: unknown; content?: unknown };
  isPartial: boolean;
  expanded: boolean;
  hideComponent: boolean;
}

/** Groups opened one at a time (fullscreen click), keyed by their first member. */
const opened = new WeakSet<Component>();
/** Which container is rendering the component being rendered. */
let renderingParent: Container | undefined;
const groupCache = new WeakMap<Container, { key: string; byMember: Map<Component, Group> }>();

const isTool = (c: Component): c is ToolLike => c instanceof ToolExecutionComponent && !(c as unknown as ToolLike).hideComponent;
const isAssistant = (c: Component): boolean => {
  if (!(c instanceof AssistantMessageComponent)) return false;
  const stop = (c as unknown as { lastMessage?: { stopReason?: string } }).lastMessage?.stopReason;
  return stop !== "error" && stop !== "aborted";
};
const running = (t: ToolLike) => !t.result || t.isPartial;
const hasFailed = (t: ToolLike) => !running(t) && Boolean(t.result?.isError);

/** Runs of tool and assistant components; each run's members up to its last tool form a group. */
function groupsOf(parent: Container): Map<Component, Group> {
  const kids = parent.children;
  const key = `${kids.length}:${kids.map((k) => (isTool(k) ? "t" : isAssistant(k) ? "a" : "x")).join("")}`;
  const hit = groupCache.get(parent);
  if (hit?.key === key) return hit.byMember;
  const byMember = new Map<Component, Group>();
  let run: Component[] = [];
  const flush = () => {
    const last = run.findLastIndex(isTool);
    if (last >= 0) {
      const members = run.slice(0, last + 1);
      const g: Group = { members, tools: members.filter(isTool) };
      for (const m of members) byMember.set(m, g);
    }
    run = [];
  };
  for (const k of kids) {
    if (isTool(k) || isAssistant(k)) run.push(k);
    else flush();
  }
  flush();
  groupCache.set(parent, { key, byMember });
  return byMember;
}

function steps(g: Group): Step[] {
  return g.tools.map((t) => ({ tool: t.toolName, args: t.args ?? {}, ...(running(t) ? {} : { result: t.result! }) }));
}

/** The summary line, with a blank line above it like any transcript block. */
function header(g: Group, open: boolean): string[] {
  const s = summarizeSteps(steps(g));
  const t = theme();
  const busy = s.running > 0;
  const text = busy ? `Working · ${s.text.charAt(0).toLowerCase()}${s.text.slice(1)}` : s.text;
  const failed = s.failed ? t.fg("error", ` · ${s.failed} failed`) : "";
  const now = busy && s.current ? t.fg("muted", ` · now: ${s.current}`) : "";
  return ["", ` ${t.fg(busy ? "accent" : "muted", text)}${failed}${now} ${t.fg("dim", open ? "⌄" : "›")}`];
}

let themeRef: { fg(color: string, text: string): string } | undefined;
const theme = () => themeRef ?? { fg: (_c: string, s: string) => s };

/** What a group member renders instead of itself, or undefined to render normally. */
function collapsedRender(c: Component, original: () => string[]): string[] | undefined {
  if (view !== "grouped" || !renderingParent) return undefined;
  const g = groupsOf(renderingParent).get(c);
  if (!g) return undefined;
  // Pi's expanded view (every step with full output) wins.
  if (g.tools.some((t) => t.expanded)) return undefined;
  const open = opened.has(g.members[0]!);
  const own = open || (isTool(c) && hasFailed(c)) ? original() : [];
  return g.members[0] === c ? [...header(g, open), ...own] : own;
}

export function installCollapsedSteps(ui: ExtensionUIContext): () => void {
  let tui: TUI | undefined;
  ui.setWidget("b4agent.steps", (t, th) => {
    tui = t;
    themeRef = th as never;
    return { render: () => [], invalidate: () => undefined };
  });
  if (!installed) {
    installed = true;
    patch();
  }
  // Ctrl+O (Pi's tools key) cycles grouped -> every step -> full output -> grouped.
  const off = ui.onTerminalInput((data) => {
    if (isKeyRelease(data) || !tui || !getKeybindings().matches(data, "app.tools.expand" as never)) return undefined;
    const focused = (tui as unknown as { getFocusedComponent?: () => unknown }).getFocusedComponent?.() as { getText?: unknown } | undefined;
    if (typeof focused?.getText !== "function") return undefined;
    if (view === "grouped") {
      view = "steps";
      tui.requestRender();
      return { consume: true };
    }
    // From "steps" Pi expands; from Pi's expanded view it collapses, and the groups come back.
    if (ui.getToolsExpanded()) view = "grouped";
    return undefined;
  });
  return () => {
    off();
    ui.setWidget("b4agent.steps", undefined);
  };
}

/** For tests: switch the view without a key press. */
export function setStepsView(v: View): void {
  view = v;
}

function patch(): void {
  const containerRender = Container.prototype.render;
  Container.prototype.render = function (this: Container, width: number): string[] {
    const prev = renderingParent;
    renderingParent = this;
    try {
      return containerRender.call(this, width);
    } finally {
      renderingParent = prev;
    }
  };

  for (const proto of [ToolExecutionComponent.prototype, AssistantMessageComponent.prototype] as unknown as { render(width: number): string[]; handleMouse?: (e: TuiMouseEvent) => unknown }[]) {
    const render = proto.render;
    proto.render = function (this: Component, width: number): string[] {
      // The parent is rendering this component; capture it before the component renders its own children.
      const parent = renderingParent;
      const original = () => render.call(this, width);
      if (!parent) return original();
      return collapsedRender(this, original) ?? original();
    };
    const mouse = proto.handleMouse;
    proto.handleMouse = function (this: Component, event: TuiMouseEvent) {
      const parent = findParent(this);
      const g = parent && view === "grouped" ? groupsOf(parent).get(this) : undefined;
      // The summary line is row 1 of the group's first member (row 0 is the blank line above it).
      if (g && g.members[0] === this && event.type === "click" && event.y === 1 && !g.tools.some((t) => t.expanded)) {
        if (opened.has(this)) opened.delete(this);
        else opened.add(this);
        return { handled: true, render: true };
      }
      return mouse?.call(this, event);
    };
  }
}

/** Mouse events arrive without the render-time parent; the chat container is the one holding the component. */
const parents = new WeakMap<Component, Container>();
function findParent(c: Component): Container | undefined {
  return parents.get(c);
}
const addChild = Container.prototype.addChild;
Container.prototype.addChild = function (this: Container, child: Component): void {
  if (child instanceof ToolExecutionComponent || child instanceof AssistantMessageComponent) parents.set(child, this);
  addChild.call(this, child);
};
