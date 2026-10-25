import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ChildHandle } from "../agents/hub.js";
import agents from "./agents.js";
import checkpoints from "./checkpoints.js";
import permissions, { createPermissionShared, type PermissionShared } from "./permissions.js";
import spec from "./spec.js";
import btw from "./btw.js";
import steps from "./steps.js";
import recap from "./recap.js";
import schedule from "./schedule.js";
import nested from "./nested.js";
import memory from "./memory.js";
import hooks from "./hooks.js";
import painter from "./painter.js";
import init from "./init.js";
import usage from "./usage.js";
import tui from "./tui.js";
import autotitle from "./autotitle.js";
import diagnostics from "./diagnostics.js";
import environment from "./environment.js";
import web from "./web.js";
import history from "./history.js";
import { registerReviewCommands } from "./commands.js";
import { registerAskUser } from "../tools/ask-user.js";
import { assetDir } from "../prompt.js";

/**
 * b4agent's extensions, loaded together so they share in-process state
 * (checkpoint status for the gate, the agent hub, the permission mode).
 * Subagents load the same factory in child mode: no checkpoints of their
 * own (the main session's cover the shared checkout), the main session's
 * permission mode and grants, and the child protocol tools.
 */
export function makeExtension(opts: { child?: ChildHandle; shared?: PermissionShared } = {}): ExtensionFactory {
  const shared = opts.shared ?? createPermissionShared();
  const makeChild = ({ child }: { child?: ChildHandle }) => makeExtension({ ...(child ? { child } : {}), shared });
  return (pi: ExtensionAPI) => {
    // Bundled skills (plan section 9), for the main agent and subagents alike.
    pi.on("resources_discover", () => ({ skillPaths: [assetDir("skills")] }));
    if (!opts.child) {
      checkpoints(pi);
      // Questions to the user and spec mode belong to the main agent; children ask their parent.
      registerAskUser(pi);
      spec(pi, shared);
      registerReviewCommands(pi);
      btw(pi, { classify: (tool, input, ctx) => shared.classify(tool, input, ctx) });
      steps(pi);
      recap(pi);
      init(pi);
      usage(pi);
      // Theme, header, footer, spinner, title and bell, /changes; then the session title, checker diagnostics and the environment prompt section.
      tui(pi);
      autotitle(pi);
      diagnostics(pi);
      environment(pi);
    }
    // Image generation, registered on session start when a backend has credentials.
    painter(pi);
    // web_fetch always; web_search on session start when an OpenAI login can run it.
    web(pi);
    // session_search and session_read: active in main; in children only when the type lists them (historian).
    history(pi, { child: Boolean(opts.child) });
    schedule(pi, opts.child ? { child: opts.child.name } : {});
    // Settings-defined shell hooks. Pi runs tool_call handlers in registration order and stops at the
    // first block, so this goes before every guard and the gate: a hook deny short-circuits them.
    hooks(pi, { shared, ...(opts.child ? { child: opts.child } : {}) });
    // Subdirectory AGENTS.md on demand and memory (read-only in children; its guard runs before the gate).
    nested(pi);
    memory(pi, { child: Boolean(opts.child) });
    // The stale-read guard (in agents) runs before the gate, so a stale edit is refused without asking anyone.
    agents(pi, { ...(opts.child ? { child: opts.child } : {}), makeExtension: makeChild });
    permissions(pi, { shared, child: Boolean(opts.child) });
  };
}

export default function b4agent(pi: ExtensionAPI) {
  return makeExtension()(pi);
}
