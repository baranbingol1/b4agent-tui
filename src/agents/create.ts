import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ModelLookup, resolveModel } from "../config.js";
import { serializeDialog } from "../dialogs.js";
import { type AgentType, parseAgentType } from "./types.js";

/**
 * `agent_create` (plan section 2, "Custom types made by the agent"): writes
 * `<name>.md` to the project's `.pi/agents/` (trusted projects only) or to
 * `~/.b4agent/agents/`, the folders `loadAgentTypes` reads. The user always
 * confirms the exact file in a dialog, in every permission mode (yolo
 * included: the dialog is the tool's own, not the gate's), and the new type
 * is usable at once.
 */

export const NAME = /^[a-z][a-z0-9-]*$/;
const MAX_CHARS = 64_000;
/** Pi's tools plus the child protocol tools, which aren't registered in the main session. */
const ALWAYS_KNOWN = ["read", "bash", "edit", "write", "grep", "find", "ls", "submit", "report", "ask"];

export const CREATE = "Create";
export const EDIT = "Edit before saving";
export const REJECT = "Reject";
export const REJECT_WHY = "Reject and say why";

export interface CreateDeps {
  /** b4agent's home (`~/.b4agent`, or `$B4AGENT_HOME`). */
  b4agentDir: string;
  /** Where project types live: the git root, else the cwd (the same root `loadAgentTypes` gets). */
  projectRoot(ctx: ExtensionContext): string;
  /** The current types, for collision notes. Undefined before the session started. */
  types(): Map<string, AgentType> | undefined;
  /** Reloads types from disk into the live set; returns the new set. */
  reload(ctx: ExtensionContext): Map<string, AgentType> | undefined;
  roles(): Record<string, string[]>;
}

export function targetPath(scope: "project" | "global", name: string, b4agentDir: string, projectRoot: string): string {
  return scope === "project" ? join(projectRoot, ".pi", "agents", `${name}.md`) : join(b4agentDir, "agents", `${name}.md`);
}

const out = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

/** Problems the loader would accept silently but that are probably mistakes. */
export function warningsFor(t: AgentType, roles: Record<string, string[]>, models: ModelLookup | undefined, toolNames: string[]): string[] {
  const w: string[] = [];
  const role = /^@([^:]+)/.exec(t.model)?.[1];
  if (role && !roles[role]) w.push(`model role @${role} is not defined (roles: ${Object.keys(roles).map((r) => "@" + r).join(", ")})`);
  else if (models && !resolveModel(t.model, roles, models)) w.push(`model ${t.model} has no model with a login right now; it would run on the caller's model`);
  const known = new Set([...ALWAYS_KNOWN, ...toolNames]);
  for (const x of t.tools ?? []) if (!known.has(x)) w.push(`tool "${x}" doesn't exist in this session`);
  if (!t.prompt) w.push("the body (the system prompt) is empty");
  return w;
}

function collisions(t: AgentType, scope: "project" | "global", path: string, types: Map<string, AgentType> | undefined): string[] {
  const notes: string[] = [];
  if (existsSync(path)) notes.push(`Replaces the existing file.`);
  const cur = types?.get(t.name);
  if (cur && cur.path !== path) {
    if (cur.source === "builtin") notes.push(`Overrides the builtin type "${t.name}".`);
    else if (cur.source === "project" && scope === "global") notes.push(`The project type "${t.name}" (${cur.path}) still takes precedence in this project.`);
    else notes.push(`Overrides the ${cur.source} type "${t.name}" (${cur.path}).`);
  }
  return notes;
}

function shownPath(p: string): string {
  const home = process.env.HOME ?? homedir();
  return p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

function preview(content: string): string {
  const lines = content.replace(/\s+$/, "").split("\n");
  const room = Math.max(8, (process.stdout.rows || 40) - 18);
  const shown = lines.slice(0, room).map((l) => "  " + l);
  if (lines.length > room) shown.push(`  … ${lines.length - room} more lines (${EDIT} shows the whole file)`);
  return shown.join("\n");
}

export function registerAgentCreate(pi: ExtensionAPI, deps: CreateDeps) {
  pi.registerTool({
    name: "agent_create",
    label: "agent_create",
    description:
      "Create or replace a subagent type: one markdown file whose frontmatter configures the agent (name, description, model, thinking, tools, isolation, context, max_turns, max_calls, locked, output) and whose body is its system prompt. " +
      "Only when the user asks for a new or changed type; follow the create-subagent skill to draft and audit it first. The user sees the exact file and approves or rejects it, so pass the final content. " +
      "scope project saves it in this repository's .pi/agents/ (trusted projects only); global saves it in ~/.b4agent/agents/ for every project. Once saved, the type can be started right away.",
    promptSnippet: "Save a new subagent type after the user approves the file",
    parameters: Type.Object({
      name: Type.String({ description: "The type name, same as the frontmatter name: lowercase letters, digits and dashes." }),
      scope: Type.Union([Type.Literal("project"), Type.Literal("global")]),
      content: Type.String({ description: "The complete file: frontmatter between --- lines, then the system prompt." }),
    }),
    async execute(_id, p, signal, _u, ctx) {
      const name = p.name.trim();
      if (!NAME.test(name)) throw new Error("name must be lowercase letters, digits and dashes, starting with a letter");
      if (p.scope === "project" && !ctx.isProjectTrusted()) throw new Error("this project isn't trusted, so project types don't load here; use scope global, or ask the user to trust the project");
      // select / input / editor work in the TUI and over RPC; without a UI nobody can approve.
      if (!ctx.hasUI) throw new Error(`creating a subagent type needs the user to approve the file, and nobody can answer in ${ctx.mode} mode`);
      const path = targetPath(p.scope, name, deps.b4agentDir, deps.projectRoot(ctx));
      const toolNames = pi.getAllTools().map((t) => t.name);

      let content = p.content;
      const check = (c: string): AgentType => {
        if (c.length > MAX_CHARS) throw new Error(`the file is ${c.length} characters; keep it under ${MAX_CHARS}`);
        const t = parseAgentType(c, p.scope === "project" ? "project" : "user", path);
        if (typeof t === "string") throw new Error(t);
        if (t.name !== name) throw new Error(`the frontmatter name "${t.name}" differs from name "${name}"`);
        return t;
      };
      let type = check(content);
      let edited = false;

      // One dialog at a time with permission asks from every agent.
      const decision = await serializeDialog(async (): Promise<{ ok: true } | { ok: false; reason?: string }> => {
        for (;;) {
          const notes = [...collisions(type, p.scope, path, deps.types()), ...warningsFor(type, deps.roles(), ctx.modelRegistry, toolNames).map((w) => `Warning: ${w}`)];
          const title = [
            `Create subagent type "${name}"?`,
            `Saves ${shownPath(path)} (${p.scope === "project" ? "this project" : "every project"}).${edited ? " Edited by you." : ""}`,
            ...notes,
            "",
            preview(content),
          ].join("\n");
          const choice = await ctx.ui.select(title, [CREATE, EDIT, REJECT, REJECT_WHY], signal ? { signal } : undefined);
          if (choice === CREATE) return { ok: true };
          if (choice === EDIT) {
            const next = await ctx.ui.editor(`Edit ${name}.md`, content);
            if (next === undefined || next === content) continue;
            try {
              type = check(next);
              content = next;
              edited = true;
            } catch (e) {
              ctx.ui.notify(`Not saved: ${(e as Error).message}. The previous version is shown again.`, "error");
            }
            continue;
          }
          if (choice === REJECT_WHY) {
            const reason = await ctx.ui.input("Why? (the agent sees this)", "", signal ? { signal } : undefined);
            return { ok: false, ...(reason?.trim() ? { reason: reason.trim() } : {}) };
          }
          return { ok: false };
        }
      });

      if (!decision.ok) {
        const why = decision.reason ? ` They said: ${decision.reason}` : "";
        return out(`The user rejected the subagent type "${name}"; nothing was saved.${why} Don't save it another way; change it as they asked, or ask them what to change.`, { rejected: true, ...(decision.reason ? { reason: decision.reason } : {}) });
      }

      mkdirSync(dirname(path), { recursive: true });
      // Write then rename, so a session loading types never sees half a file.
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, content.endsWith("\n") ? content : content + "\n");
      renameSync(tmp, path);
      const types = deps.reload(ctx);
      const live = types?.get(name);
      const active = live?.path === path;
      const warnings = warningsFor(type, deps.roles(), ctx.modelRegistry, toolNames);
      const lines = [
        `Saved the subagent type "${name}" to ${path}${edited ? " (with the user's edits; read it if you need the final text)" : ""}.`,
        active
          ? `It is available now: start it with agent { type: "${name}" }.`
          : live
            ? `A ${live.source} type with the same name (${live.path}) takes precedence here, so agent { type: "${name}" } starts that one.`
            : "It didn't load into this session; the user sees the loader's error.",
        ...warnings.map((w) => `Warning: ${w}`),
      ];
      return out(lines.join("\n"), { path, name, scope: p.scope, edited });
    },
  });
}
