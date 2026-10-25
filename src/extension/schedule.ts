import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { currentHub, MAIN } from "../agents/hub.js";
import { projectDir } from "../checkpoints/store.js";
import { b4agentDir } from "../permissions/config.js";
import { gitInfo } from "../permissions/git.js";
import { DurableStore, selfHolder } from "../schedule/durable.js";
import { Pacer } from "../schedule/pacer.js";
import { describeRule, intervalRule, type Job, MIN_DELAY_MS, MIN_INTERVAL_MS, parseInterval, parseRRule, type Rule, ruleMs, Scheduler } from "../schedule/scheduler.js";
import { loadScheduleSettings } from "../schedule/settings.js";

/**
 * /loop and the schedule tools (plan section 20). The scheduler lives in the
 * main session; subagents reach it through the same module, so any agent
 * can set up or tear down a schedule for itself or another agent. Runs are
 * follow-up messages marked as scheduled, so they never interrupt a turn.
 * Schedules stop when the session closes, except durable ones, which the
 * next session in the project picks up (durable.ts). The self-paced /loop's
 * fallback wakeup is pacer.ts.
 */

const ENTRY = "b4agent-schedules";
interface Current {
  s: Scheduler;
  pacer: Pacer;
  /** Undefined in print mode and before the session starts: durable schedules need a session that stays open. */
  store?: DurableStore;
}
let current: Current | undefined;

const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text" as const, text: t }], details });

function when(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((ms - now) / 1000));
  return s < 90 ? `in ${s}s` : s < 5400 ? `in ${Math.round(s / 60)}m` : `in ${(s / 3600).toFixed(1)}h`;
}

/** Local "YYYY-MM-DD HH:MM". */
function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const minutes = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}` : `${Math.round(ms / 1000)} seconds`);

export function describeJob(j: Job): string {
  const by = j.owner === "user" ? "you (/loop)" : j.owner;
  const state = j.paused ? `paused: ${j.paused}` : j.missed ? `missed (was due ${stamp(j.missed)}), firing now` : `next ${when(j.nextAt)}`;
  const mode = j.runMode === "fresh" ? ", a fresh agent each run" : "";
  const kind = j.fallback ? " (the self-paced loop's fallback wakeup)" : "";
  const durable = j.durable ? ", durable" : "";
  return `${j.id}: wakes ${j.target} ${describeRule(j.rule)}${kind}${mode}${durable}, ${state}, set by ${by}, ${j.runs} run${j.runs === 1 ? "" : "s"} so far — "${j.prompt.split("\n")[0]!.slice(0, 80)}"`;
}

/** The provenance line every scheduled run starts with. */
export function runHeader(job: Job): string {
  const by = job.owner === "user" ? "the user's /loop" : job.owner;
  const bits = [job.id, `run ${job.runs}`];
  if (job.rule) bits.push(describeRule(job.rule));
  if (job.fallback) bits.push("fallback wakeup");
  if (job.durable) bits.push("durable");
  if (job.missed) bits.push(`missed: it was due ${stamp(job.missed)}, while no b4agent session in this project was open to run it`);
  return `[scheduled by ${by} (${bits.join(", ")}), not typed by the user]`;
}

const loopNote = (fallbackMs: number) =>
  fallbackMs > 0
    ? `When this round is done, call set_schedule with delay_seconds for when to look again, choosing the delay from what you're waiting for. When the loop's goal is reached or nothing is left to wait for, call clear_schedule to end the loop, and say so. If you do neither, you'll be woken once more after about ${minutes(fallbackMs)}, and the loop ends if that round doesn't schedule another either.`
    : "When this round is done, call set_schedule with delay_seconds for when to look again, choosing the delay from what you're waiting for. When the loop's goal is reached or nothing is left to wait for, call clear_schedule to end the loop, and say so. A round that schedules nothing ends the loop.";

export default function schedule(pi: ExtensionAPI, opts: { child?: string }) {
  const self = opts.child ?? MAIN;
  registerTools(pi, self);
  if (opts.child) return;

  let ctxRef: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** The main-agent job that started the current run, to pause it if the run fails. */
  let firedMain: Job | undefined;
  /** Why the last main run failed, for the self-paced loop; cleared when a run starts. */
  let lastFailure: string | undefined;
  let store: DurableStore | undefined;
  /** Saves go to schedules.json only once this session has had a durable job. */
  let durableSeen = false;
  let settings = loadScheduleSettings();

  const tell = (owner: string, msg: string) => {
    // A durable job's owner may be a subagent of an earlier session; then the user hears it.
    if (owner !== "user" && currentHub()?.agents.has(owner)) void currentHub()?.deliver(owner, msg, { trigger: false, customType: "b4agent-schedule" }).catch(() => undefined);
    else ctxRef?.ui.notify(msg, "warning");
  };

  const status = () => {
    const n = [...scheduler.jobs.values()].filter((j) => !j.fallback).length;
    const parts = [pacer.loop ? "self-paced loop" : "", n ? `${n} scheduled` : ""].filter(Boolean);
    ctxRef?.ui.setStatus("b4agent.schedule", parts.length ? parts.join(" · ") : undefined);
  };

  const saveDurable = (jobs: Job[]) => {
    if (!store) return;
    if (jobs.some((j) => j.durable)) durableSeen = true;
    if (!durableSeen) return;
    try {
      const lost = store.sync(jobs);
      if (lost.length)
        queueMicrotask(() => {
          for (const j of [...scheduler.jobs.values()]) if (j.durable && lost.includes(j.durable)) scheduler.remove(j.id);
          ctxRef?.ui.notify(`Another b4agent session in this project took over ${lost.length} durable schedule${lost.length === 1 ? "" : "s"}; dropped here.`, "warning");
        });
    } catch (e) {
      ctxRef?.ui.notify(`Could not save durable schedules: ${(e as Error).message}`, "warning");
    }
  };

  const scheduler = new Scheduler({
    now: () => Date.now(),
    busy: (target) => {
      if (target === MAIN) return !ctxRef || !ctxRef.isIdle();
      const r = currentHub()?.agents.get(target);
      return !r || r.status === "running" || r.status === "starting" || r.status === "waiting";
    },
    fire: async (job) => {
      const hub = currentHub();
      const head = runHeader(job);
      pacer.fired(job);
      if (job.runMode === "fresh") {
        const type = hub?.types.get("general");
        const ctx = ctxRef;
        if (!hub || !type || !ctx) throw new Error("subagents are not available");
        const caller = job.owner !== "user" && hub.agents.has(job.owner) ? job.owner : MAIN;
        await hub.start({ caller, callerCtx: ctx, type, prompt: `${head}\n${job.prompt}` });
        return;
      }
      if (job.target === MAIN) {
        firedMain = job;
        // The agent's own wakeup during a self-paced loop carries the loop's rules, so it doesn't forget to reschedule.
        const note = pacer.loop && !job.loop ? `\n\n(Self-paced /loop. ${loopNote(pacer.fallbackMs)})` : "";
        pi.sendMessage({ customType: "b4agent-scheduled", content: `${head}\n${job.prompt}${note}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
        return;
      }
      const r = hub?.agents.get(job.target);
      if (!hub || !r) throw new Error(`${job.target} is gone`);
      if (r.status === "failed") throw new Error(`${job.target} failed on its last run`);
      await hub.deliver(job.target, `${head}\n${job.prompt}`, { customType: "b4agent-scheduled" });
    },
    changed: (jobs) => {
      pi.appendEntry(ENTRY, { jobs });
      saveDurable(jobs);
      status();
    },
  });
  // Pausing happens inside the scheduler; the owner hears about it here.
  const pause = scheduler.pause.bind(scheduler);
  scheduler.pause = (j, reason) => {
    pause(j, reason);
    tell(j.owner, `[schedule ${j.id} paused] ${reason}. Resume it with update_schedule { paused: false } or /loop resume ${j.id}.`);
  };

  const pacer = new Pacer(scheduler, {
    now: () => Date.now(),
    get fallbackMs() {
      return settings.fallbackMs;
    },
    target: MAIN,
    fallbackPrompt: (l) =>
      `${l.prompt}\n\n(Fallback wakeup of the self-paced /loop: the last round ended without set_schedule or clear_schedule. Do this round, then call set_schedule with delay_seconds for the next one, or clear_schedule to end the loop. If you do neither, the loop ends after this round.)`,
  });
  const cur: Current = { s: scheduler, pacer };

  pi.on("session_start", (_e, ctx) => {
    ctxRef = ctx;
    current = cur;
    pacer.forget();
    settings = loadScheduleSettings();
    let saved: Job[] = [];
    for (const e of ctx.sessionManager.getBranch()) if (e.type === "custom" && e.customType === ENTRY) saved = ((e.data as { jobs?: Job[] })?.jobs ?? []).filter((j) => j && typeof j.id === "string");
    // A self-paced loop isn't restored (Claude Code doesn't either), so neither is its fallback. Durable jobs come from schedules.json, which is newer.
    scheduler.load(saved.filter((j) => !j.fallback && !j.durable));
    store = undefined;
    durableSeen = false;
    if (ctx.hasUI) {
      store = new DurableStore(projectDir(b4agentDir(), gitInfo(ctx.cwd).root ?? ctx.cwd), selfHolder());
      cur.store = store;
      try {
        const taken = store.adopt();
        for (const j of taken) scheduler.adopt(j);
        const missed = taken.filter((j) => j.missed).length;
        if (taken.length)
          ctx.ui.notify(
            `Picked up ${taken.length} durable schedule${taken.length === 1 ? "" : "s"} from an earlier session${missed ? `; ${missed} missed run${missed === 1 ? "" : "s"} fire${missed === 1 ? "s" : ""} now` : ""}. /loop list shows them.`,
            "info",
          );
      } catch (e) {
        ctx.ui.notify(`Could not read durable schedules: ${(e as Error).message}`, "warning");
      }
    } else delete cur.store;
    status();
    if (timer) clearInterval(timer);
    timer = setInterval(() => void scheduler.tick(), 1000);
    timer.unref();
  });

  pi.on("before_agent_start", (_e, ctx) => {
    ctxRef = ctx;
  });

  pi.on("agent_start", () => {
    lastFailure = undefined;
  });

  pi.on("agent_end", (event) => {
    const job = firedMain;
    firedMain = undefined;
    const last = event.messages.at(-1) as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
    if (last?.role === "assistant" && last.stopReason === "error") {
      lastFailure = last.errorMessage ?? "model error";
      if (job) scheduler.pause(job, `its run failed: ${lastFailure}`);
    }
  });

  pi.on("agent_settled", (e) => {
    const r = pacer.settled({ aborted: e.aborted, ...(lastFailure ? { failed: lastFailure } : {}) });
    if (r.outcome === "armed") ctxRef?.ui.notify(`Self-paced loop: no next wakeup was set, so ${r.job.id} checks back ${when(r.job.nextAt)}. /loop stop ends the loop.`, "info");
    else if (r.outcome === "ended") {
      const left = [...scheduler.jobs.values()].filter((j) => j.target === MAIN && !j.loop).map((j) => j.id);
      ctxRef?.ui.notify(`Self-paced loop ended: ${r.reason}.${left.length ? ` Still scheduled: ${left.join(", ")} (/loop stop <id>).` : ""}`, "info");
    }
    status();
  });

  pi.on("session_shutdown", () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    pacer.forget();
    try {
      store?.release();
    } catch {
      // the next session sees this one's pid gone and adopts its jobs anyway
    }
    store = undefined;
    if (current === cur) current = undefined;
  });

  pi.registerCommand("loop", {
    description: "Run a prompt on a schedule: /loop 5m <prompt>, /loop --durable 5m <prompt>, /loop <prompt> (self-paced), /loop list, /loop stop [id|all]",
    getArgumentCompletions: (prefix) => ["list", "stop ", "resume ", "--durable "].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c.trim() })),
    handler: async (args, ctx) => {
      let a = args.trim();
      const [first = "", ...rest] = a.split(/\s+/);
      if (!a || first === "list") {
        const jobs = [...scheduler.jobs.values()].map(describeJob);
        if (pacer.loop) jobs.unshift(`self-paced loop: "${pacer.loop.prompt.split("\n")[0]!.slice(0, 80)}" (/loop stop ends it)`);
        ctx.ui.notify(jobs.length ? jobs.join("\n") : "Nothing is scheduled. /loop 5m <prompt> runs a prompt every 5 minutes.", "info");
        return;
      }
      if (first === "stop" || first === "resume") {
        const id = rest[0] ?? "";
        if (first === "stop" && !id) {
          if (pacer.stop()) {
            status();
            return ctx.ui.notify("Stopped the self-paced loop.", "info");
          }
          return ctx.ui.notify("No self-paced loop is running. /loop stop <id|all> stops a schedule; /loop list shows them.", "warning");
        }
        const ids = id === "all" ? [...scheduler.jobs.keys()] : [id];
        let n = 0;
        let loopEnded = false;
        if (first === "stop" && id === "all") loopEnded = pacer.stop();
        for (const i of ids) {
          const j = scheduler.jobs.get(i);
          if (!j) continue;
          if (first === "stop") {
            // Stopping the loop's fallback, or main's wakeup during the loop, stops the loop.
            if (pacer.loop && (pacer.isFallback(i) || (j.target === MAIN && !j.loop))) loopEnded = pacer.stop() || loopEnded;
            scheduler.remove(i);
          } else scheduler.update(i, { paused: undefined, nextAt: Date.now() });
          n++;
        }
        status();
        const what = `${first === "stop" ? "Stopped" : "Resumed"} ${n} schedule${n === 1 ? "" : "s"}${loopEnded ? " and the self-paced loop" : ""}.`;
        ctx.ui.notify(n || loopEnded ? what : `No schedule "${id}". /loop list shows them.`, n || loopEnded ? "info" : "warning");
        return;
      }
      // "--durable" goes first: /loop --durable 5m <prompt>.
      let durable = false;
      if (first === "--durable") {
        durable = true;
        a = rest.join(" ");
      }
      const [head = "", ...tail] = a.split(/\s+/);
      // "/loop 5m prompt", "/loop every 5 minutes prompt", or a self-paced "/loop prompt".
      let ms = parseInterval(head);
      let prompt = tail.join(" ");
      if (ms === undefined && head === "every") {
        const m = /^every\s+(\d+\s*\w+)\s+([\s\S]+)$/i.exec(a);
        if (m) {
          ms = parseInterval(m[1]!);
          prompt = m[2]!;
        }
      }
      if (ms !== undefined) {
        if (!prompt.trim()) return ctx.ui.notify("Say what to run: /loop 5m <prompt>.", "warning");
        if (ms < MIN_INTERVAL_MS) return ctx.ui.notify("The shortest /loop interval is one minute.", "warning");
        if (durable && !cur.store) return ctx.ui.notify("Durable schedules need an interactive session.", "warning");
        const rule = intervalRule(ms);
        // Runs now, then on the interval (Claude Code's /loop).
        const job = scheduler.add({ owner: "user", target: MAIN, prompt: prompt.trim(), rule, nextAt: Date.now(), runMode: "existing", loop: true, ...(durable ? { durable: randomUUID() } : {}) });
        if (typeof job === "string") return ctx.ui.notify(job, "warning");
        ctx.ui.notify(`Loop ${job.id}: ${describeRule(rule)}${durable ? ", durable (later sessions in this project carry it on)" : ""}, starting now. /loop stop ${job.id} ends it.`, "info");
        return;
      }
      if (!a) return ctx.ui.notify("Say what to run: /loop --durable 5m <prompt>.", "warning");
      if (durable) return ctx.ui.notify("--durable needs an interval (/loop --durable 5m <prompt>). A self-paced loop lives in this session; the agent can make a wakeup durable itself with set_schedule.", "warning");
      pacer.start(a);
      status();
      const message = `${a}\n\n(This is a self-paced /loop. ${loopNote(pacer.fallbackMs)})`;
      if (ctx.isIdle()) pi.sendUserMessage(message);
      else pi.sendUserMessage(message, { deliverAs: "followUp" });
    },
  });
}

function registerTools(pi: ExtensionAPI, self: string) {
  const need = () => {
    if (!current) throw new Error("scheduling is not available in this session");
    return current;
  };
  const resolveTarget = (t: string | undefined): string | { error: string } => {
    const target = t?.trim() || self;
    if (target === MAIN || currentHub()?.agents.has(target)) return target;
    return { error: `No agent named "${target}". Agents: ${[MAIN, ...(currentHub()?.agents.keys() ?? [])].join(", ")}.` };
  };
  const timing = (p: { rrule?: string; delay_seconds?: number }): { rule?: Rule; nextAt: number } | string => {
    if (p.rrule && p.delay_seconds !== undefined) return "Give rrule or delay_seconds, not both.";
    if (p.rrule) {
      const rule = parseRRule(p.rrule);
      if (typeof rule === "string") return `Bad rrule: ${rule}.`;
      // COUNT=1 is a one-shot after one interval.
      return { ...(rule.count === 1 ? {} : { rule }), nextAt: Date.now() + Math.max(MIN_INTERVAL_MS, ruleMs(rule)) };
    }
    if (p.delay_seconds !== undefined) {
      const ms = p.delay_seconds * 1000;
      if (!(ms >= MIN_DELAY_MS)) return `delay_seconds must be at least ${MIN_DELAY_MS / 1000}.`;
      return { nextAt: Date.now() + ms };
    }
    return "Give rrule (recurring) or delay_seconds (one wakeup).";
  };
  /** Durable jobs need a session that keeps running and a target that exists in the next session. */
  const durableError = (c: Current, target: string): string | undefined => {
    if (!c.store) return "Durable schedules need an interactive session.";
    if (target !== MAIN) return `Only schedules that wake ${MAIN} can be durable: subagents don't outlive the session.`;
    return undefined;
  };

  pi.registerTool({
    name: "set_schedule",
    label: "set_schedule",
    description:
      "Wake an agent (yourself by default) later with a prompt: once after delay_seconds, or on an RRULE (FREQ=MINUTELY|HOURLY|DAILY|WEEKLY, INTERVAL, COUNT; at least one minute apart). Each agent has one schedule; setting it again replaces it. " +
      'Use it to wait for something outside this session (CI, a deploy, a long external job) or for recurring checks. Don\'t use it to poll another agent: message it and ask it to reply when it\'s done. run_mode "fresh" starts a new general subagent for each run instead of waking an existing agent. ' +
      `Schedules end when the session closes, unless durable is true (only for waking ${MAIN}): then the next session in this project runs a missed run once, marked missed, and a recurring schedule carries on.`,
    promptSnippet: "Schedule a later or recurring wakeup for yourself or another agent",
    parameters: Type.Object({
      prompt: Type.String({ description: "What the woken agent should do. Write it for a reader who has only its own context." }),
      delay_seconds: Type.Optional(Type.Number({ description: "One wakeup after this many seconds." })),
      rrule: Type.Optional(Type.String({ description: 'Recurring, e.g. "FREQ=MINUTELY;INTERVAL=10" or "FREQ=HOURLY;COUNT=3".' })),
      target: Type.Optional(Type.String({ description: 'Agent to wake; default yourself. "main" is the top-level agent.' })),
      run_mode: Type.Optional(Type.Union([Type.Literal("existing"), Type.Literal("fresh")])),
      durable: Type.Optional(Type.Boolean({ description: "Also keep it for later sessions in this project, in case this one closes first." })),
    }),
    async execute(_id, p) {
      const c = need();
      const target = resolveTarget(p.target);
      if (typeof target !== "string") return text(target.error);
      const t = timing(p);
      if (typeof t === "string") return text(t);
      if (p.durable) {
        const err = durableError(c, target);
        if (err) return text(err);
      }
      const job = c.s.add({ owner: self, target, prompt: p.prompt, ...(t.rule ? { rule: t.rule } : {}), nextAt: t.nextAt, runMode: p.run_mode ?? "existing", ...(p.durable ? { durable: randomUUID() } : {}) });
      if (typeof job === "string") return text(job);
      if (target === MAIN) c.pacer.wakeupChanged();
      return text(`Scheduled. ${describeJob(job)}`, { id: job.id });
    },
  });

  pi.registerTool({
    name: "get_schedule",
    label: "get_schedule",
    description: "Show the schedule that wakes an agent (yourself by default), or every schedule in the session with target \"all\".",
    promptSnippet: "Show an agent's schedule",
    parameters: Type.Object({ target: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const { s, pacer } = need();
      if (p.target === "all") {
        const lines = [...s.jobs.values()].map(describeJob);
        if (pacer.loop) lines.unshift(`A self-paced /loop is running: "${pacer.loop.prompt.split("\n")[0]!.slice(0, 80)}".`);
        return text(lines.join("\n") || "Nothing is scheduled.");
      }
      const target = resolveTarget(p.target);
      if (typeof target !== "string") return text(target.error);
      const j = s.agentSchedule(target);
      const loop = target === MAIN && pacer.loop ? " A self-paced /loop is running; clear_schedule ends it." : "";
      return text(`${j ? describeJob(j) : `Nothing wakes ${target}.`}${loop}`);
    },
  });

  pi.registerTool({
    name: "update_schedule",
    label: "update_schedule",
    description: "Change an agent's schedule (yourself by default): its prompt, timing, run mode, durability, or paused state. A paused schedule resumes with paused: false.",
    promptSnippet: "Change or pause an agent's schedule",
    parameters: Type.Object({
      target: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      delay_seconds: Type.Optional(Type.Number()),
      rrule: Type.Optional(Type.String()),
      run_mode: Type.Optional(Type.Union([Type.Literal("existing"), Type.Literal("fresh")])),
      paused: Type.Optional(Type.Boolean()),
      durable: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p) {
      const c = need();
      const s = c.s;
      const target = resolveTarget(p.target);
      if (typeof target !== "string") return text(target.error);
      const j = s.agentSchedule(target);
      if (!j) return text(`Nothing wakes ${target}; use set_schedule.`);
      const patch: Parameters<Scheduler["update"]>[1] = {};
      if (p.rrule || p.delay_seconds !== undefined) {
        const t = timing(p);
        if (typeof t === "string") return text(t);
        patch.nextAt = t.nextAt;
        patch.rule = t.rule;
      }
      if (p.prompt) patch.prompt = p.prompt;
      if (p.run_mode) patch.runMode = p.run_mode;
      if (p.paused === true) patch.paused = "paused by " + self;
      if (p.paused === false) {
        patch.paused = undefined;
        patch.nextAt ??= Date.now();
      }
      if (p.durable === true && !j.durable) {
        const err = durableError(c, target);
        if (err) return text(err);
        patch.durable = randomUUID();
      }
      if (p.durable === false) patch.durable = undefined;
      s.update(j.id, patch);
      if (target === MAIN) c.pacer.wakeupChanged();
      return text(`Updated. ${describeJob(s.jobs.get(j.id)!)}`);
    },
  });

  pi.registerTool({
    name: "clear_schedule",
    label: "clear_schedule",
    description: `Remove the schedule that wakes an agent (yourself by default). For ${MAIN}, it also ends a self-paced /loop: call it when the loop's goal is reached.`,
    promptSnippet: "Remove an agent's schedule, or end a self-paced /loop",
    parameters: Type.Object({ target: Type.Optional(Type.String()) }),
    async execute(_id, p) {
      const { s, pacer } = need();
      const target = resolveTarget(p.target);
      if (typeof target !== "string") return text(target.error);
      const j = s.agentSchedule(target);
      const loop = target === MAIN && pacer.stop();
      if (j) s.remove(j.id);
      const done = [j ? `Cleared ${j.id}.` : `Nothing wakes ${target}.`, loop ? "The self-paced /loop has ended." : ""].filter(Boolean).join(" ");
      return text(done);
    },
  });
}
