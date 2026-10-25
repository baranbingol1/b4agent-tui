import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentRecord, Hub } from "./hub.js";
import { checkSubmission, type OutputSchema, parseOutputSchema } from "./schema.js";

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

function elapsed(from: number, to = Date.now()): string {
  const s = Math.round((to - from) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export function rosterLine(a: AgentRecord): string {
  const status = a.needsUser ? "needs the user" : a.status;
  const what = a.status === "running" && a.activity ? `, ${a.activity}` : "";
  const wt = a.worktree ? ", own worktree" : "";
  return `- ${a.name} (${a.type}, ${a.model}): ${status}${what}, ${elapsed(a.startedAt, a.status === "running" ? undefined : a.endedAt)}, started by ${a.parent}${wt}`;
}

function describeRecord(hub: Hub, a: AgentRecord): string {
  const parts = [rosterLine(a).slice(2)];
  if (a.asked) parts.push(`Question waiting for ${a.parent}: ${a.asked}`);
  if (a.error) parts.push(`Error: ${a.error}`);
  if (a.result !== undefined) parts.push(`Result:\n${hub.inline(a)}`);
  else if (a.status === "running") parts.push("Still running; no result yet.");
  else if (a.dormant) parts.push("From an earlier run of this session; message it to continue with its full context.");
  const recent = a.reports.slice(-3);
  if (recent.length) parts.push(`Progress notes:\n${recent.map((r) => `- ${r.text}`).join("\n")}`);
  const note = hub.patchNote(a).trim();
  if (note) parts.push(note);
  return parts.join("\n\n");
}

export function roster(hub: Hub, viewer: string): string {
  const agents = [...hub.agents.values()];
  const jobs = [...hub.jobs.values()].filter((j) => j.status === "running");
  const lines = [`You are ${viewer}. Agents in this session: main${agents.length ? "" : " only"}.`];
  for (const a of agents) lines.push(rosterLine(a));
  if (jobs.length) {
    lines.push("Background jobs:");
    for (const j of jobs) lines.push(`- ${j.id} (${j.owner}): ${j.command.split("\n")[0]!.slice(0, 80)}, ${elapsed(j.startedAt)}, log ${j.log}`);
  }
  return lines.join("\n");
}

/**
 * `agent`, `message` and `agents`, registered for the main agent and every
 * child. `self` is the caller's name ("main" in the root session).
 */
export function registerAgentTools(pi: ExtensionAPI, hub: () => Hub | undefined, self: string, opts: { canSpawn: () => boolean }) {
  const need = (): Hub => {
    const h = hub();
    if (!h) throw new Error("subagents are not available in this session");
    return h;
  };

  if (opts.canSpawn()) {
    pi.registerTool({
      name: "agent",
      label: "agent",
      description:
        "Start a subagent. It runs in parallel and in the background by default: you get a message with its result when it finishes, and can keep working meanwhile. " +
        "Fresh agents see only your prompt, so write a complete brief: the goal, what you already know, where to look, and what to return. " +
        "Agents share your checkout unless isolation is \"worktree\"; give parallel writers disjoint files, or use a worktree when they can't be split. " +
        "The available types are listed in your system prompt under <agents>.",
      promptSnippet: "Start a read-only helper subagent (search, librarian, historian, reviewer)",
      parameters: Type.Object({
        type: Type.String({ description: "Agent type, from <agents> in the system prompt." }),
        prompt: Type.String({ description: "The complete brief." }),
        name: Type.Optional(Type.String({ description: "Name to address it by; default <type>-<n>." })),
        background: Type.Optional(Type.Boolean({ description: "Default true. False waits for the result and returns it here." })),
        fork: Type.Optional(Type.Boolean({ description: "Start from a copy of your conversation instead of only the prompt." })),
        isolation: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("worktree")], { description: "worktree: its own git worktree; changes come back as a patch." })),
        model: Type.Optional(Type.String({ description: "Override the type's model: @role or provider/id, optionally :thinking." })),
        complexity: Type.Optional(
          Type.Union([Type.Literal("light"), Type.Literal("medium"), Type.Literal("heavy")], {
            description: "How hard the task is: light runs a small fast model, medium the type's own, heavy the strongest. model wins over it; types marked (fixed model) ignore both.",
          }),
        ),
        schema: Type.Optional(
          Type.Unknown({ description: "JSON Schema for structured output: the agent must submit data matching it, and you get the data as JSON with its result. Replaces the type's own output schema." }),
        ),
      }),
      async execute(_id, p, signal, _u, ctx) {
        const h = need();
        const type = h.types.get(p.type);
        if (!type) return text(`Unknown agent type "${p.type}". Types: ${[...h.types.keys()].join(", ")}.`);
        let schema: OutputSchema | undefined;
        if (p.schema !== undefined && p.schema !== null) {
          const s = parseOutputSchema(p.schema);
          if (typeof s === "string") throw new Error(`schema: ${s}`);
          schema = s;
        }
        const rec = await h.start({
          caller: self,
          callerCtx: ctx,
          type,
          prompt: p.prompt,
          ...(p.name ? { name: p.name } : {}),
          fork: p.fork ?? type.context === "fork",
          ...(p.isolation ? { isolation: p.isolation } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.complexity ? { complexity: p.complexity } : {}),
          ...(schema !== undefined ? { schema } : {}),
        });
        const locked = type.locked && (p.model || p.complexity) ? ` ${type.name} always runs on its own model, so model and complexity were ignored.` : "";
        if (p.background === false) {
          // Ctrl+B releases this wait; the result then arrives as a message like a background agent's.
          const done = await h.foregroundWait(self, rec.name, signal);
          if (done && (done.status === "running" || done.status === "starting"))
            return text(`${rec.name} keeps running in the background. You'll get its result as a message when it finishes.`, { agent: rec.name });
          return text(done ? describeRecord(h, done) + locked : `${rec.name} is gone.`, { agent: rec.name, ...(done?.data !== undefined ? { data: done.data } : {}) });
        }
        return text(`Started ${rec.name} (${rec.type}, ${rec.model})${rec.worktree ? ` in its own worktree at ${rec.worktree.path}` : ""}. You'll get its result as a message when it finishes; keep working meanwhile.${locked}`, { agent: rec.name });
      },
    });
  }

  pi.registerTool({
    name: "message",
    label: "message",
    description:
      "Send a message to another agent in this session, by name (\"main\" is the top-level agent). A running agent sees it after its current step; an idle or finished one starts a new turn with its full context, so this is also how you answer an agent's question or give it follow-up work.",
    promptSnippet: "Message another agent by name (answers questions, gives follow-up work)",
    parameters: Type.Object({
      to: Type.String({ description: "Agent name, or \"main\"." }),
      text: Type.String(),
    }),
    async execute(_id, p) {
      return text(await need().message(self, p.to.trim(), p.text));
    },
  });

  pi.registerTool({
    name: "agents",
    label: "agents",
    description:
      "Manage agents and background jobs. list: everyone in this session. read: an agent's status and latest result (doesn't consume it). wait: block until the named agent (or any of yours that's running) finishes, and return its result. stop: stop an agent or a background job. apply: apply a worktree agent's patch to your checkout.",
    promptSnippet: "List, read, wait for, stop agents and background jobs; apply worktree patches",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("stop"), Type.Literal("apply")]),
      name: Type.Optional(Type.String({ description: "Agent name or job id." })),
      timeout_seconds: Type.Optional(Type.Number({ description: "For wait: give up after this long." })),
    }),
    async execute(_id, p, signal) {
      const h = need();
      const name = p.name?.trim();
      switch (p.action) {
        case "list":
          return text(roster(h, self));
        case "read": {
          const a = name ? h.agents.get(name) : undefined;
          if (!a) return text(`No agent named "${name ?? ""}".\n${roster(h, self)}`);
          return text(describeRecord(h, a));
        }
        case "wait": {
          const timeout = p.timeout_seconds ? p.timeout_seconds * 1000 : undefined;
          if (name) {
            const a = await h.wait(name, signal, timeout);
            if (!a) return text(`No agent named "${name}".`);
            return text(describeRecord(h, a));
          }
          const mine = [...h.agents.values()].filter((a) => a.parent === self && (a.status === "running" || a.status === "starting")).map((a) => a.name);
          if (!mine.length) return text("None of your agents is running.");
          const a = await h.waitAny(mine, signal, timeout);
          return text(a ? describeRecord(h, a) : "Stopped waiting.");
        }
        case "stop": {
          if (!name) return text("Name the agent or job to stop.");
          const job = h.jobs.get(name);
          if (job) {
            if (job.status !== "running") return text(`${name} already ended.`);
            job.kill();
            return text(`Stopping ${name}.`);
          }
          return text((await h.stop(name)) ? `Stopped ${name}.` : `No agent or job named "${name}".`);
        }
        case "apply":
          if (!name) return text("Name the agent whose patch to apply.");
          return text(await h.apply(name));
      }
    },
  });
}

/** Tools only children have: how they hand back results, progress and questions. */
export function registerChildTools(pi: ExtensionAPI, hub: Hub, self: string) {
  const rec = () => hub.agents.get(self);
  // The schema is fixed when the child starts, so the description is stable for its whole life.
  const structured = rec()?.schema !== undefined;
  pi.registerTool({
    name: "submit",
    label: "submit",
    description: structured
      ? "Hand your final result to the agent that started you and end your turn. result: a short self-contained summary. data: required, and it must match the JSON Schema in your system prompt; a mismatch comes back as an error to fix and submit again."
      : "Hand your final result to the agent that started you and end your turn. Make it self-contained: they haven't seen your work. If you don't call it, your last message is your result.",
    promptSnippet: "Return your final result to whoever started you",
    parameters: Type.Object({
      result: Type.String(),
      data: Type.Optional(Type.Unknown({ description: structured ? "The structured output, matching the schema in your system prompt." : "Optional structured output; it reaches the caller as JSON." })),
    }),
    async execute(_id, p) {
      const r = rec();
      let data = p.data;
      if (r?.schema !== undefined) {
        if (data === undefined) throw new Error("data is missing. Call submit again with data matching the JSON Schema in your system prompt.");
        const checked = checkSubmission(r.schema, data);
        if ("errors" in checked) throw new Error(`data doesn't match the output schema:\n${checked.errors.map((e) => `- ${e}`).join("\n")}\nFix these and call submit again.`);
        data = checked.data;
      }
      if (r) {
        r.submitted = p.result;
        r.submittedData = data;
      }
      return { ...text("Result submitted."), terminate: true };
    },
  });
  pi.registerTool({
    name: "report",
    label: "report",
    description: "Send a short progress note to the agent that started you without stopping. Use it sparingly, for milestones they'd act on.",
    promptSnippet: "Send a short progress note without stopping",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, p) {
      return text(hub.report(self, p.text));
    },
  });
  pi.registerTool({
    name: "ask",
    label: "ask",
    description: "Ask the agent that started you a question you can't answer yourself, and pause. Your turn ends; their reply arrives as a message and you continue with your full context.",
    promptSnippet: "Ask whoever started you a question and pause",
    parameters: Type.Object({ question: Type.String() }),
    async execute(_id, p) {
      const r = rec();
      if (r) r.asked = p.question;
      return { ...text("Question sent. Stop here; the answer arrives as a message."), terminate: true };
    },
  });
}

