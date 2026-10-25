import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isInside, realpathOr, resolveToolPath } from "../context/nested.js";
import { memorySection, memoryStores, readIfFile, type Store, topicFiles } from "../memory/store.js";
import { b4agentDir } from "../permissions/config.js";
import { gitInfo, realpathPrefix } from "../permissions/git.js";
import { classifyBash } from "../permissions/rules/bash.js";
import type { PermissionContext } from "../permissions/types.js";

/**
 * Auto memory (Claude Code-style; see src/memory/store.ts). The `memory`
 * system prompt section is built at session start (and again after /reload,
 * which restarts the session, and after compaction, which already rebuilds
 * the prompt) and set unchanged before every run, so the prompt cache holds.
 * The main agent saves with write/edit; the permission gate allows writes
 * under ~/.b4agent. Subagents get the indexes read-only and can't change the
 * stores with write/edit or with bash (redirects, tee, cp, rm, ... as the
 * permission gate parses them); reads stay allowed.
 */
export default function memory(pi: ExtensionAPI, opts: { child?: boolean } = {}) {
  const dir = b4agentDir();
  let stores: Store[] = [];
  let section: string | undefined;

  const snapshot = (ctx: ExtensionContext) => {
    stores = memoryStores(dir, ctx.cwd);
    section = memorySection(stores, { readOnly: opts.child ?? false });
  };
  pi.on("session_start", (_e, ctx) => snapshot(ctx));
  pi.on("session_compact", (_e, ctx) => snapshot(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    if (!stores.length) snapshot(ctx);
    if (section) event.systemPromptOptions.sections.memory = section;
  });

  if (opts.child) {
    const inStore = (target: string) => stores.some((s) => isInside(target, s.dir) || isInside(realpathPrefix(target), realpathOr(s.dir)));
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName === "bash") {
        // The gate's own parse of the command: redirects, tee, cp/mv, sed -i, rm and the rest, with
        // variables resolved the way the gate resolves them. Reads (cat, grep) have no targets.
        const command = event.input.command;
        if (typeof command !== "string" || !command) return;
        const hit = bashWriteTargets(command, ctx.cwd, dir).find(inStore);
        if (hit) return { block: true, reason: `Memory is read-only for subagents, through bash too: this command writes ${hit}. Don't write the memory stores; say what's worth remembering in your result and the main agent will save it.` };
        return;
      }
      if (event.toolName !== "write" && event.toolName !== "edit") return;
      const p = event.input.path;
      if (typeof p !== "string" || !p) return;
      const target = resolveToolPath(p, ctx.cwd);
      if (inStore(target)) return { block: true, reason: "Memory is read-only for subagents. If something is worth remembering, say so in your result and the main agent can save it." };
      return;
    });
    return;
  }

  pi.registerCommand("memory", {
    description: "Memory stores (global and project): list them and open a file to view or edit",
    handler: async (_args, ctx) => {
      const all = memoryStores(dir, ctx.cwd);
      const lines = all.map((s) => {
        const raw = readIfFile(s.index);
        const topics = topicFiles(s);
        return `${s.scope}: ${s.dir}/\n  ${raw === undefined ? "no MEMORY.md yet" : `MEMORY.md, ${raw.replace(/\n+$/, "").split("\n").length} lines`} · ${topics.length} topic file${topics.length === 1 ? "" : "s"}`;
      });
      const summary = `${lines.join("\n")}\n\nThis session loaded the indexes when it started; edits show up in the next session or after /reload.`;
      if (!ctx.hasUI) {
        ctx.ui.notify(summary, "info");
        return;
      }
      const options: { label: string; path: string }[] = [];
      for (const s of all) {
        options.push({ label: `${s.scope} · MEMORY.md`, path: s.index });
        for (const t of topicFiles(s)) options.push({ label: `${s.scope} · ${t}`, path: `${s.dir}/${t}` });
      }
      const pick = await ctx.ui.select(`${summary}\n\nOpen which file?`, [...options.map((o) => o.label), "Close"]);
      const file = options.find((o) => o.label === pick)?.path;
      if (!file) return;
      const before = readIfFile(file) ?? "";
      const after = await ctx.ui.editor(file, before);
      if (after === undefined || after === before) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, after.endsWith("\n") || after === "" ? after : `${after}\n`);
      ctx.ui.notify(`Saved ${file}. It loads in the next session (or after /reload).`, "info");
    },
  });
}

/**
 * Every path a bash command writes or deletes, as the permission gate resolves
 * it (`Verdict.targets`): `~`, `cd`, variables assigned in the command and the
 * inherited environment are followed; an unknown expansion counts as empty.
 * Commands the gate can't see into (`python -c`, `node -e`) have none.
 */
export function bashWriteTargets(command: string, cwd: string, b4agentHome: string): string[] {
  const home = process.env.HOME ?? homedir();
  const ctx: PermissionContext = { cwd, workspace: gitInfo(cwd).root ?? cwd, home, b4agentDir: b4agentHome, env: { ...process.env }, realpath: realpathPrefix };
  return classifyBash(command, ctx).targets ?? [];
}
