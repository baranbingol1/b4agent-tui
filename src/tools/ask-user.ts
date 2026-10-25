/**
 * ask_user (plan section 18): batched multiple-choice questions for the
 * user, Codex `request_user_input` / Claude Code AskUserQuestion shape.
 *
 * The picker is adapted from Pi's examples/extensions/questionnaire.ts
 * (MIT, Copyright (c) Mario Zechner): tab bar, option list, free-text
 * "Other". Changes: the schema (header, 2-4 options, multiSelect), a notes
 * field instead of a bare "Type something", JSON results keyed by id, and
 * dismissal meaning "continue on your best judgment".
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface Option {
  label: string;
  description?: string;
}
interface Question {
  id: string;
  header: string;
  question: string;
  options: Option[];
  multiSelect?: boolean;
}
type Answer = { selected: string[]; other?: string };

const OTHER = "Other (type your answer)";

const Params = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String({ description: "Key for this answer in the result." }),
      header: Type.String({ description: "Tab label, at most 12 characters, e.g. 'Storage'." }),
      question: Type.String({ description: "The full question." }),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "At most 5 words. Put the recommended option first and end its label with (Recommended)." }),
          description: Type.Optional(Type.String({ description: "What choosing it means, one line." })),
        }),
        { minItems: 2, maxItems: 4 },
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: "Let the user pick several." })),
    }),
    { minItems: 1, maxItems: 3 },
  ),
});

export function registerAskUser(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user",
    label: "ask_user",
    description:
      "Ask the user 1-3 multiple-choice questions in one dialog and wait for the answers. Use it when a decision belongs to the user and materially changes what you do: requirements, scope, trade-offs between valid approaches. " +
      "Explore first and never ask what the code, the docs or the environment can answer. Batch related decisions into one call instead of asking one at a time. Don't use it for permission to run a command (the permission system handles that) or to ask whether to continue. " +
      "The UI adds an 'Other' answer with free text, so don't add one. If the user dismisses the dialog, continue on your best judgment and state your assumptions.",
    promptSnippet: "Ask the user 1-3 multiple-choice questions about decisions that are theirs",
    parameters: Params,
    async execute(_id, params, _signal, _u, ctx) {
      if (!ctx.hasUI || ctx.mode !== "tui") {
        return { content: [{ type: "text", text: "Nobody can answer questions in this mode. Continue on your best judgment and state your assumptions." }], details: {} };
      }
      const questions = params.questions.map((q, i) => ({ ...q, id: q.id || `q${i + 1}`, header: (q.header || `Q${i + 1}`).slice(0, 12) })) as Question[];
      const answers = await ctx.ui.custom<Map<string, Answer> | undefined>((tui, theme, _kb, done) => picker(tui, theme, questions, done));
      if (!answers || !answers.size) {
        return { content: [{ type: "text", text: "The user dismissed the questions. Continue on your best judgment and state the assumptions you made." }], details: { dismissed: true } };
      }
      const out: Record<string, unknown> = {};
      for (const q of questions) {
        const a = answers.get(q.id);
        if (!a) {
          out[q.id] = "(not answered: use your best judgment and state the assumption)";
          continue;
        }
        const picked = q.multiSelect ? a.selected : a.selected[0];
        out[q.id] = a.other !== undefined ? { ...(a.selected.length ? { selected: picked } : {}), other: a.other } : picked;
      }
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], details: { answers: out } };
    },
    renderCall(args, theme) {
      const qs = ((args as { questions?: Question[] }).questions ?? []).map((q) => q.header).join(", ");
      return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", qs), 0, 0);
    },
  });
}

function picker(tui: TUI, theme: Theme, questions: Question[], done: (r: Map<string, Answer> | undefined) => void) {
  let tab = 0;
  let index = 0;
  let typing: string | undefined;
  let cache: string[] | undefined;
  const answers = new Map<string, Answer>();
  const multi = questions.length > 1;
  const editorTheme: EditorTheme = {
    borderColor: (s) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    },
  };
  const editor = new Editor(tui, editorTheme);
  const refresh = () => {
    cache = undefined;
    tui.requestRender();
  };
  const current = () => questions[tab];
  const options = () => {
    const q = current();
    if (!q) return [];
    return [...q.options.map((o) => o.label), ...(q.multiSelect ? ["Done"] : []), OTHER];
  };
  const next = () => {
    if (!multi) return done(answers);
    tab = tab < questions.length - 1 ? tab + 1 : questions.length;
    index = 0;
    refresh();
  };
  editor.onSubmit = (value) => {
    const q = current();
    if (!q || typing === undefined) return;
    const prev = answers.get(q.id);
    answers.set(q.id, { selected: q.multiSelect ? (prev?.selected ?? []) : [], other: value.trim() || "(no text)" });
    typing = undefined;
    editor.setText("");
    next();
  };

  function handleInput(data: string) {
    if (typing !== undefined) {
      if (matchesKey(data, Key.escape)) {
        typing = undefined;
        editor.setText("");
        refresh();
        return;
      }
      editor.handleInput(data);
      refresh();
      return;
    }
    if (multi && (matchesKey(data, Key.right) || matchesKey(data, Key.shift("right")) || matchesKey(data, Key.tab))) {
      tab = (tab + 1) % (questions.length + 1);
      index = 0;
      return refresh();
    }
    if (multi && (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab")))) {
      tab = (tab + questions.length) % (questions.length + 1);
      index = 0;
      return refresh();
    }
    if (matchesKey(data, Key.escape)) return done(answers.size ? answers : undefined);
    if (tab === questions.length) {
      if (matchesKey(data, Key.enter)) done(answers);
      return;
    }
    const opts = options();
    if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
    else if (matchesKey(data, Key.down)) index = Math.min(opts.length - 1, index + 1);
    else if (matchesKey(data, Key.enter)) {
      const q = current()!;
      const label = opts[index]!;
      if (label === OTHER) {
        typing = q.id;
        editor.setText(answers.get(q.id)?.other ?? "");
      } else if (q.multiSelect && label === "Done") {
        if (!answers.has(q.id)) answers.set(q.id, { selected: [] });
        next();
        return;
      } else if (q.multiSelect) {
        const a = answers.get(q.id) ?? { selected: [] };
        a.selected = a.selected.includes(label) ? a.selected.filter((s) => s !== label) : [...a.selected, label];
        answers.set(q.id, a);
      } else {
        answers.set(q.id, { selected: [label] });
        next();
        return;
      }
    }
    refresh();
  }

  function render(width: number): string[] {
    if (cache) return cache;
    const w = Math.max(1, width);
    const lines: string[] = [];
    const wrap = (prefix: string, text: string) => {
      const pw = visibleWidth(prefix);
      const parts = wrapTextWithAnsi(text, Math.max(1, w - pw));
      parts.forEach((p, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${p}`));
    };
    lines.push(theme.fg("accent", "─".repeat(w)));
    if (multi) {
      const tabs = questions.map((q, i) => {
        const text = ` ${answers.has(q.id) ? "■" : "□"} ${q.header} `;
        return i === tab ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answers.has(q.id) ? "success" : "muted", text);
      });
      const submit = " ✓ Submit ";
      tabs.push(tab === questions.length ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg(answers.size === questions.length ? "success" : "dim", submit));
      wrap(" ", tabs.join(" "));
      lines.push("");
    }
    const q = current();
    if (tab === questions.length) {
      wrap(" ", theme.fg("accent", theme.bold("Ready to submit")));
      for (const qq of questions) {
        const a = answers.get(qq.id);
        const shown = a ? [...a.selected, ...(a.other ? [`“${a.other}”`] : [])].join(", ") || "(none)" : theme.fg("warning", "not answered");
        wrap(" ", `${theme.fg("muted", `${qq.header}: `)}${shown}`);
      }
      lines.push("");
      wrap(" ", theme.fg("dim", "Enter submit · ←→ back to a question · Esc dismiss"));
    } else if (q) {
      wrap(" ", theme.bold(q.question));
      if (q.multiSelect) wrap(" ", theme.fg("dim", "Pick any, then Done."));
      lines.push("");
      const a = answers.get(q.id);
      options().forEach((label, i) => {
        const sel = i === index;
        const checked = q.multiSelect && a?.selected.includes(label) ? "[x] " : q.multiSelect && label !== "Done" && label !== OTHER ? "[ ] " : "";
        wrap(sel ? theme.fg("accent", "> ") : "  ", theme.fg(sel ? "accent" : "text", `${i + 1}. ${checked}${label}`));
        const desc = q.options.find((o) => o.label === label)?.description;
        if (desc) wrap("     ", theme.fg("muted", desc));
      });
      if (typing !== undefined) {
        lines.push("");
        wrap(" ", theme.fg("muted", "Your answer (Enter to save, Esc to cancel):"));
        for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
      } else {
        lines.push("");
        wrap(" ", theme.fg("dim", `${multi ? "←→ questions · " : ""}↑↓ move · Enter ${q.multiSelect ? "toggle" : "choose"} · Esc dismiss`));
      }
    }
    lines.push(theme.fg("accent", "─".repeat(w)));
    cache = lines;
    return lines;
  }

  return { render, invalidate: () => (cache = undefined), handleInput };
}
