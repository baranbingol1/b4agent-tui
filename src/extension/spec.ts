import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { projectDir } from "../checkpoints/store.js";
import { loadB4Config, resolveModel } from "../config.js";
import { b4agentDir } from "../permissions/config.js";
import { gitInfo } from "../permissions/git.js";
import type { PermissionShared } from "./permissions.js";

/**
 * Spec mode (plan section 7, Droid's spec mode with Codex pieces).
 * Shift+Tab toggles it. While it is on, every agent is read-only (enforced
 * by the permission gate), the agent gathers requirements with ask_user, and
 * exit_spec opens the approval dialog. An optional `spec` model role is used
 * while it's on. It is just a mode: Shift+Tab out and say "implement this"
 * works too.
 */

const ENTRY = "b4agent-spec-mode";
const STATUS = "b4agent.spec";

const PROCEED = "Proceed with auto mode";
const NEW_CHAT = "Proceed in a new chat";
const ITERATE = "Keep iterating";
const SAVE = "Save the spec";

const READ_ONLY_REASON =
  "Spec mode is read-only: you can read, search and run read-only commands, but not edit files or run anything that changes state. Finish the spec and call exit_spec, or ask the user to leave spec mode (Shift+Tab).";

export function slug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/, "") || "spec"
  );
}

export default function spec(pi: ExtensionAPI, shared: PermissionShared) {
  const dir = b4agentDir();
  let on = false;
  let saved: { provider: string; id: string; thinking: string } | undefined;
  /** Set by "Proceed in a new chat"; the new session opens once this run settles. */
  let handoff: string | undefined;

  const specsDir = (ctx: ExtensionContext) => join(projectDir(dir, gitInfo(ctx.cwd).root ?? ctx.cwd), "specs");

  function save(ctx: ExtensionContext, title: string, body: string): string {
    const d = specsDir(ctx);
    mkdirSync(d, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    let path = join(d, `${date}-${slug(title)}.md`);
    for (let n = 2; ; n++) {
      try {
        writeFileSync(path, `# ${title.trim()}\n\n${body.trim()}\n`, { flag: "wx" });
        return path;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        path = join(d, `${date}-${slug(title)}-${n}.md`);
      }
    }
  }

  async function set(next: boolean, ctx: ExtensionContext, opts: { quiet?: boolean; persist?: boolean } = {}) {
    if (next === on) return;
    on = next;
    shared.readOnly = on ? { reason: READ_ONLY_REASON } : undefined;
    if (opts.persist !== false) pi.appendEntry(ENTRY, { on });
    ctx.ui.setStatus(STATUS, on ? ctx.ui.theme.fg("warning", "spec mode") : undefined);
    const config = loadB4Config(dir);
    if (on && config.roles.spec) {
      const r = resolveModel("@spec", config.roles, ctx.modelRegistry);
      if (r && ctx.model && (r.model.provider !== ctx.model.provider || r.model.id !== ctx.model.id)) {
        saved = { provider: ctx.model.provider, id: ctx.model.id, thinking: pi.getThinkingLevel() };
        await pi.setModel(r.model);
        if (r.thinking) pi.setThinkingLevel(r.thinking as never);
      }
    } else if (!on && saved) {
      const back = ctx.modelRegistry.getAll().find((m) => m.provider === saved!.provider && m.id === saved!.id);
      if (back) await pi.setModel(back);
      pi.setThinkingLevel(saved.thinking as never);
      saved = undefined;
    }
    if (!opts.quiet) ctx.ui.notify(on ? "Spec mode: read-only until you approve a spec. Shift+Tab leaves." : "Spec mode off.", "info");
    // The mode lives in the system prompt; a note in the conversation marks the switch for the model.
    if (!on && !opts.quiet) pi.sendMessage({ customType: "b4agent-spec", content: "Spec mode is off: you can edit files and run commands again.", display: false }, { deliverAs: "nextTurn" });
  }

  pi.on("session_start", async (_e, ctx) => {
    on = false;
    saved = undefined;
    shared.readOnly = undefined;
    ctx.ui.setStatus(STATUS, undefined);
    let restored = false;
    for (const e of ctx.sessionManager.getBranch()) if (e.type === "custom" && e.customType === ENTRY) restored = Boolean((e.data as { on?: boolean })?.on);
    if (restored) await set(true, ctx, { quiet: true, persist: false });
  });

  pi.registerShortcut("shift+tab", {
    description: "Toggle spec mode (read-only planning with an approval step)",
    handler: async (ctx) => set(!on, ctx),
  });

  pi.registerCommand("spec", {
    description: "Toggle spec mode: plan read-only, then approve the spec",
    handler: async (args, ctx) => {
      await set(!on, ctx);
      if (on && args.trim()) pi.sendUserMessage(args.trim());
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!on) return;
    event.systemPromptOptions.sections.spec_mode = `Spec mode is on. You are planning, not implementing: every agent in this session is read-only until the user approves a spec.
- Explore the code first, then use ask_user for every decision that materially changes the plan and that the code can't answer. Batch related questions into one call.
- Converge on a concrete spec: the goal, the decisions made and why, the files to change and how, how it will be verified, and what is out of scope. Keep it as short as the change allows.
- When it's ready, call exit_spec with a title and the spec in markdown. The user approves it, asks for changes, or keeps it for later. Don't ask "shall I proceed?" in text; exit_spec is how you ask.`;
  });

  pi.registerTool({
    name: "exit_spec",
    label: "exit_spec",
    description: "Spec mode only: present the finished spec for approval. The user can proceed in this chat (auto permissions), proceed in a new chat, keep iterating, or save it for later.",
    promptSnippet: "Present the finished spec for approval (spec mode only)",
    parameters: Type.Object({
      title: Type.String({ description: "A short title, used for the file name." }),
      spec: Type.String({ description: "The spec in markdown." }),
    }),
    async execute(_id, p, _signal, _u, ctx) {
      const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details, terminate: true });
      if (!on) return { content: [{ type: "text", text: "Spec mode is off; just do the work (or tell the user the plan in text)." }], details: {} };
      if (!ctx.hasUI) return text("Nobody can approve a spec in this mode. Present the spec in text and stop.");
      const choice = await ctx.ui.select(`${p.title}\n\n${p.spec.trim()}\n`, [PROCEED, NEW_CHAT, ITERATE, SAVE]);
      if (choice === PROCEED) {
        const path = save(ctx, p.title, p.spec);
        await set(false, ctx, { quiet: true });
        shared.setMode("auto");
        ctx.ui.notify(`Spec saved to ${path}. Implementing in auto mode.`, "info");
        return { content: [{ type: "text", text: `The user approved the spec (saved to ${path}). Spec mode is off and permissions are in auto mode. Implement it now, then verify it as the spec says.` }], details: { path, choice: "proceed" } };
      }
      if (choice === NEW_CHAT) {
        const path = save(ctx, p.title, p.spec);
        await set(false, ctx, { quiet: true });
        handoff = path;
        return text(`The user will implement the spec in a new chat (saved to ${path}). Stop here.`, { path, choice: "new-chat" });
      }
      if (choice === SAVE) {
        const path = save(ctx, p.title, p.spec);
        ctx.ui.notify(`Spec saved to ${path}.`, "info");
        return text(`Saved the spec to ${path}. Spec mode stays on; stop and wait for the user.`, { path, choice: "save" });
      }
      return text("The user wants to keep iterating on the spec. Stop and wait for their message.", { choice: "iterate" });
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("exit_spec ")) + theme.fg("muted", String((args as { title?: string }).title ?? "")), 0, 0);
    },
  });

  // Opening a new chat needs a command context, so the tool hands off to a hidden command once the run has settled.
  pi.on("agent_settled", () => {
    if (!handoff) return;
    const path = handoff;
    handoff = undefined;
    pi.sendUserMessage(`/b4agent-spec-handoff ${path}`, { expandPromptTemplates: true });
  });

  pi.registerCommand("b4agent-spec-handoff", {
    description: "(internal) open a new chat to implement a saved spec",
    handler: async (args, ctx) => {
      const path = args.trim();
      if (!path) return;
      const parent = ctx.sessionManager.getSessionFile();
      await ctx.newSession({
        ...(parent ? { parentSession: parent } : {}),
        withSession: async (next) => next.ui.setEditorText(`please implement this spec: ${path}`),
      });
    },
  });
}
