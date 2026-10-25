import { basename, join } from "node:path";
import { getAgentDir, InteractiveMode, type ExtensionAPI, type ExtensionContext, type ReadonlyFooterDataProvider, type Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { currentHub, type Hub } from "../agents/hub.js";
import { b4agentDir } from "../permissions/config.js";
import { assetDir } from "../prompt.js";
import { ChangeLog, ChangesView, changesTable } from "../tui/changes.js";
import { ColdCacheTracker, sentFromEntries, type HistoryEntry } from "../tui/cold-cache.js";
import { focusState, lastInputAt, startFocusTracking } from "../tui/focus.js";
import { renderFooter, STATUS, usageTotals, type UsageTotals } from "../tui/footer.js";
import { countLoaded, Header, nextTip } from "../tui/header.js";
import { shouldRing, terminalTitle } from "../tui/notify.js";
import { installRainbowBorder, setTopLevel, topLevel } from "../tui/rainbow.js";
import { loadTuiSettings, type TuiSettings } from "../tui/settings.js";
import { CHARM_AFTER_MS, CHARMS, loadWordList, pacmanFrames, PACMAN_INTERVAL_MS, pickWord, ROTATE_MS, WAVE_MS, waveText, WORDS } from "../tui/spinner.js";
import { CURATED, DEFAULT_THEME, orderThemes, ThemePicker } from "../tui/theme.js";

const BUNDLED = new Set(CURATED.map(([name]) => name));

/**
 * b4agent's look in the main session (plan section 4): the bundled themes and
 * `/theme`, the header, the 3-line footer with chips and the cold-cache hint,
 * the Pac-Man spinner, the terminal title and bell, and the changes chip with
 * `/changes`. Interactive mode only; nothing here reaches the model.
 */
export default function tui(pi: ExtensionAPI) {
  // Before Pi builds the editor, so its first border already goes through the wrapper.
  installRainbowBorder();
  hideEffortStatus();
  let ctxRef: ExtensionContext | undefined;
  let settings: TuiSettings = loadTuiSettings();
  let themeDefaulted = false;
  const cold = new ColdCacheTracker();
  const changes = new ChangeLog();
  let footerTui: TUI | undefined;
  let stopFocus: (() => void) | undefined;

  const interactive = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";

  /** Calls `then` once the theme is registered: polls briefly, gives up after 3 s. */
  function whenThemeLoaded(ctx: ExtensionContext, name: string, then: (t: Theme) => void, tries = 60) {
    let t: Theme | undefined;
    try {
      t = ctx.ui.getTheme(name);
    } catch {
      return; // stale context: a newer session took over
    }
    if (t) then(t);
    else if (tries > 0) setTimeout(() => whenThemeLoaded(ctx, name, then, tries - 1), 50).unref();
  }
  const rerender = () => footerTui?.requestRender();

  // Themes ship in themes/; Pi loads and validates them like any theme directory.
  pi.on("resources_discover", () => ({ themePaths: [assetDir("themes")] }));

  pi.on("session_start", (_e, ctx) => {
    setTopLevel(topLevel(ctx.model));
    ctxRef = ctx;
    settings = loadTuiSettings();
    cold.reset(sentFromEntries(ctx.sessionManager.getBranch() as unknown as HistoryEntry[]));
    changes.rebuild(ctx.sessionManager.getBranch(), ctx.cwd);
    if (!interactive(ctx)) return;
    ctx.ui.setStatus(STATUS.changes, changes.chip());
    if (!themeDefaulted) {
      themeDefaulted = true;
      // Pi applies the saved theme before extension themes exist (they register after session_start, from
      // resources_discover), unless they were passed with --theme. So: with no saved theme, b4agent's; with a saved
      // bundled theme Pi couldn't find yet, that one once it registers. Applied as an instance: settings.json stays as is.
      const saved = pi.getSettings().theme;
      const want = process.argv.some((a) => a.startsWith("--use-theme")) ? undefined : !saved ? DEFAULT_THEME : BUNDLED.has(saved) && ctx.ui.theme.name !== saved ? saved : undefined;
      if (want) whenThemeLoaded(ctx, want, (t) => ctx.ui.setTheme(t));
    }
    if (pi.getSettings().quietStartup !== true) {
      const tip = nextTip(b4agentDir());
      ctx.ui.setHeader((_tui, theme) => new Header(theme, () => ({ tip, ...countLoaded(ctx.getSystemPrompt()) })));
    }
    ctx.ui.setFooter((t, theme, data) => footer(t, theme, data));
    stopFocus ??= startFocusTracking(ctx.ui);
    // Pi writes its own title once the session is bound (after the provider count); ours goes after it.
    for (const ms of [0, 150, 1000]) setTimeout(() => !running && setTitle(ctx, lastMark), ms).unref();
    // The agent hub is (re)built by the agents extension's session_start, which runs after this one.
    setTimeout(syncJobs, 0);
  });

  pi.on("session_shutdown", (e) => {
    stopJobs();
    stopSpinner();
    running = false;
    if (e.reason === "quit") {
      stopFocus?.();
      stopFocus = undefined;
    }
  });

  pi.on("session_tree", (_e, ctx) => {
    ctxRef = ctx;
    cold.reset(sentFromEntries(ctx.sessionManager.getBranch() as unknown as HistoryEntry[]));
    changes.rebuild(ctx.sessionManager.getBranch(), ctx.cwd);
    if (interactive(ctx)) ctx.ui.setStatus(STATUS.changes, changes.chip());
  });

  pi.on("session_info_changed", (_e, ctx) => {
    // Pi resets the title when the name changes, after this handler; put ours back.
    if (interactive(ctx)) setTimeout(() => setTitle(ctx, running ? "⚙" : lastMark), 50).unref();
  });

  // --------------------------------------------------------------- footer

  let stats: { key: string; usage: UsageTotals; contextPercent: number | null; subscription: boolean } | undefined;
  let lastLines: string[] = [];

  function footer(t: TUI, theme: Theme, data: ReadonlyFooterDataProvider): Component & { dispose(): void } {
    footerTui = t;
    const offBranch = data.onBranchChange(() => t.requestRender());
    return {
      invalidate() {},
      dispose() {
        offBranch();
        if (footerTui === t) footerTui = undefined;
      },
      render(width: number): string[] {
        const ctx = ctxRef;
        if (!ctx) return lastLines;
        try {
          const sm = ctx.sessionManager;
          const model = ctx.model;
          const key = `${sm.getSessionId()}:${sm.getLeafId()}:${model?.provider}/${model?.id}`;
          if (stats?.key !== key) {
            const usage = ctx.getContextUsage();
            stats = { key, usage: usageTotals(sm.getEntries()), contextPercent: usage?.percent ?? null, subscription: model ? ctx.modelRegistry.isUsingOAuth(model) : false };
          }
          const name = sm.getSessionName();
          lastLines = renderFooter(
            {
              cwd: sm.getCwd(),
              branch: data.getGitBranch(),
              ...(name ? { sessionName: name } : {}),
              usage: stats.usage,
              contextPercent: stats.contextPercent,
              ...(model ? { model: { provider: model.provider, id: model.id, reasoning: Boolean(model.reasoning) } } : {}),
              thinking: pi.getThinkingLevel(),
              topEffort: pi.getThinkingLevel() === topLevel(model),
              subscription: stats.subscription,
              providerCount: data.getAvailableProviderCount(),
              statuses: data.getExtensionStatuses(),
              coldCache: cold.hint(),
            },
            width,
            theme,
          );
        } catch {
          // A context gone stale during a session switch: keep the last frame until the new one arrives.
        }
        return lastLines;
      },
    };
  }

  // ------------------------------------------------------------ cold cache

  pi.on("turn_start", (_e, ctx) => {
    if (ctx.model) cold.requestSent(ctx.model.provider, ctx.model.id, pi.getThinkingLevel(), Date.now());
  });
  pi.on("message_end", (e) => {
    if (e.message.role !== "assistant") return;
    const had = cold.hint();
    cold.replied();
    if (had !== cold.hint()) rerender();
  });
  pi.on("thinking_level_select", (e, ctx) => {
    cold.effortChanged(ctx.model?.provider, ctx.model?.id, e.level, Date.now());
    rerender();
  });
  pi.on("model_select", (_e, ctx) => {
    setTopLevel(topLevel(ctx.model));
    ctxRef = ctx;
    cold.modelChanged();
    rerender();
  });

  // ---------------------------------------------------------------- jobs

  let hub: Hub | undefined;
  let offHub: (() => void) | undefined;
  function syncJobs() {
    const ctx = ctxRef;
    const h = currentHub();
    if (h !== hub) {
      offHub?.();
      hub = h;
      offHub = h?.onChange(syncJobs);
    }
    if (!ctx || !interactive(ctx)) return;
    const n = h ? [...h.jobs.values()].filter((j) => j.status === "running").length : 0;
    try {
      ctx.ui.setStatus(STATUS.jobs, n ? `${n} job${n === 1 ? "" : "s"} running` : undefined);
    } catch {
      // stale context during a switch
    }
  }
  function stopJobs() {
    offHub?.();
    offHub = undefined;
    hub = undefined;
  }
  pi.on("tool_execution_end", () => syncJobs());

  // ------------------------------------------------------------- changes

  pi.on("tool_result", (e, ctx) => {
    if (e.isError || (e.toolName !== "edit" && e.toolName !== "write")) return;
    if (changes.record(e.toolName, e.input, e.details, Date.now(), ctx.cwd) && interactive(ctx)) ctx.ui.setStatus(STATUS.changes, changes.chip());
  });

  pi.registerCommand("changes", {
    description: "Files changed on this branch, with lines added and removed",
    handler: async (_args, ctx) => {
      if (!interactive(ctx)) return;
      await ctx.ui.custom<void>((t, theme, _kb, done) => {
        const width = (t as unknown as { terminal?: { columns?: number } }).terminal?.columns ?? 100;
        return new ChangesView(changesTable(changes.snapshot(), width - 4, Date.now()), theme, () => done());
      });
    },
  });

  // --------------------------------------------------------------- theme

  pi.registerCommand("theme", {
    description: "Pick a color theme (live preview; Esc keeps the current one)",
    getArgumentCompletions: (prefix) => {
      const names = ctxRef && interactive(ctxRef) ? orderThemes(ctxRef.ui.getAllThemes().map((t) => t.name)) : [];
      return names.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
    },
    handler: async (args, ctx) => {
      if (!interactive(ctx)) return;
      const apply = (name: string) => {
        const r = ctx.ui.setTheme(name);
        ctx.ui.notify(r.success ? `Theme: ${name}` : (r.error ?? `No theme named "${name}"`), r.success ? "info" : "error");
      };
      if (args.trim()) return apply(args.trim());
      const names = orderThemes(ctx.ui.getAllThemes().map((t) => t.name));
      const current = ctx.ui.theme.name;
      const saved = pi.getSettings().theme;
      // Previews apply a Theme instance, which Pi doesn't save; only the final pick is saved, by name.
      const preview = (name: string) => {
        const t = ctx.ui.getTheme(name);
        if (t) ctx.ui.setTheme(t);
      };
      const choice = await ctx.ui.custom<string | undefined>((_t, _theme, _kb, done) => new ThemePicker(names, current, done, preview));
      if (choice) apply(choice);
      else if (saved) ctx.ui.setTheme(saved);
      else if (current) preview(current);
    },
  });

  // ------------------------------------------------------------- spinner

  let waveTimer: NodeJS.Timeout | undefined;
  let rotateTimer: NodeJS.Timeout | undefined;
  let hiddenForStream = false;

  function stopSpinner(ctx?: ExtensionContext) {
    clearInterval(waveTimer);
    clearInterval(rotateTimer);
    waveTimer = rotateTimer = undefined;
    if (ctx) {
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingIndicator();
      if (hiddenForStream) ctx.ui.setWorkingVisible(true);
    }
    hiddenForStream = false;
  }

  pi.on("agent_start", (_e, ctx) => {
    syncJobs();
    if (!interactive(ctx)) return;
    startRun(ctx);
    if (!settings.spinner) return;
    stopSpinner();
    const dir = getAgentDir();
    const words = loadWordList([join(dir, "spinner-words.txt")], WORDS);
    const charms = loadWordList([join(dir, "spinner-charms.txt")], CHARMS);
    const started = Date.now();
    const pool = () => (Date.now() - started >= CHARM_AFTER_MS ? [...words, ...charms] : words);
    let word = pickWord(pool(), undefined);
    let tick = 0;
    ctx.ui.setWorkingIndicator({ frames: pacmanFrames(), intervalMs: PACMAN_INTERVAL_MS });
    ctx.ui.setWorkingMessage(waveText(word, tick));
    rotateTimer = setInterval(() => (word = pickWord(pool(), word)), ROTATE_MS);
    waveTimer = setInterval(() => ctx.ui.setWorkingMessage(waveText(word, ++tick)), WAVE_MS);
  });

  // While the reply streams, the text itself shows progress; the indicator returns when tool calls follow.
  pi.on("message_update", (e, ctx) => {
    if (!waveTimer || hiddenForStream) return;
    const kind = e.assistantMessageEvent.type;
    if (kind === "text_delta" || kind === "thinking_delta") {
      hiddenForStream = true;
      ctx.ui.setWorkingVisible(false);
    }
  });
  pi.on("message_end", (e, ctx) => {
    if (!hiddenForStream || e.message.role !== "assistant" || e.message.stopReason !== "toolUse") return;
    hiddenForStream = false;
    ctx.ui.setWorkingVisible(true);
  });
  pi.on("agent_end", (_e, ctx) => {
    if (interactive(ctx)) stopSpinner(ctx);
  });

  // -------------------------------------------------------------- notify

  let running = false;
  let runStartedAt = 0;
  let lastMark: string | undefined;

  function setTitle(ctx: ExtensionContext, mark?: string) {
    try {
      ctx.ui.setTitle(terminalTitle(basename(ctx.cwd), pi.getSessionName(), mark));
    } catch {
      // stale context after a session switch; the new session sets its own
    }
  }

  function startRun(ctx: ExtensionContext) {
    if (running) return;
    running = true;
    runStartedAt = Date.now();
    setTitle(ctx, "⚙");
  }

  pi.on("agent_settled", (e, ctx) => {
    syncJobs();
    if (!interactive(ctx) || !running) return;
    running = false;
    lastMark = e.aborted ? undefined : "✓";
    setTitle(ctx, lastMark);
    const now = Date.now();
    const ring = shouldRing({ focus: focusState(), runMs: now - runStartedAt, idleMs: now - lastInputAt(), minMs: settings.notify.minRunSeconds * 1000, aborted: e.aborted });
    if (ring && settings.notify.bell) process.stdout.write("\x07");
  });

  pi.on("input", (_e, ctx) => {
    // Typing again clears the done mark.
    if (lastMark && interactive(ctx)) {
      lastMark = undefined;
      setTitle(ctx);
    }
    return { action: "continue" };
  });
}

/**
 * Pi adds a "Thinking level: <level>" line to the transcript on every effort
 * change; the footer already shows the effort, so b4agent drops that one
 * message. "Default thinking level: …" (a saved default) and Pi's other
 * status lines still show. Wraps InteractiveMode's TypeScript-private
 * showStatus (Pi 1.3.0); re-check on a Pi upgrade.
 */
let effortStatusHidden = false;
function hideEffortStatus(): void {
  if (effortStatusHidden) return;
  effortStatusHidden = true;
  const proto = InteractiveMode.prototype as unknown as { showStatus?: (message: string) => void };
  const original = proto.showStatus;
  if (typeof original !== "function") return;
  proto.showStatus = function (this: unknown, message: string) {
    if (typeof message === "string" && message.startsWith("Thinking level: ")) return;
    return original.call(this, message);
  };
}
