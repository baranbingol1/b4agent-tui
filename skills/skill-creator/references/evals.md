# Testing a skill and tuning its description

<!-- The method (paired with-skill and baseline runs, assertions drafted while
     runs are in flight, a should-trigger / near-miss query set split into
     train and held-out test, the best description picked on the test split)
     follows Anthropic's skill-creator skill (anthropics/skills
     skills/skill-creator/SKILL.md at dbd4588f9e10, Apache-2.0, Copyright 2026
     Anthropic, PBC). Rewritten for b4agent by the b4agent authors, 2026-10-21:
     runs go through b4agent's `agent` tool and `b4agent -p`; Anthropic's
     scripts, viewer and grader prompts are not included. -->

Two questions, two loops. Does the skill make the work better? Compare runs with and without it. Does the agent load it when it should, and only then? Tune the description against a trigger eval. Do either only when the user wants the evidence or the skill is risky enough to need it; each run is a full agent session and costs tokens and time, so say roughly how many runs a loop will take before starting.

Keep everything under a workspace outside the skill folder and outside the repository, such as `/tmp/<skill-name>-eval/`, one `iteration-<N>/` per round, one directory per test case inside it.

## 1. Does the skill help?

**Test cases.** Write two or three prompts a real user would send: specific, with file names, data and context, not "make a chart". Show them to the user and adjust. Save them in `<workspace>/evals.json` as `[{ "id", "name", "prompt", "files", "expected" }]`, with no assertions yet.

**Runs.** For each case start two subagents in the same turn, so they finish together and see the same repository state:

- **with skill**: `agent` with type `general`, a brief that says "read `<path>/SKILL.md` first and follow it", the prompt, the input files, and "save your outputs to `<workspace>/iteration-N/<case>/with_skill/`".
- **baseline**: the same brief without the skill. For a new skill there is no skill at all (output to `without_skill/`). For a revision, snapshot the old version first (`cp -r <skill> <workspace>/skill-snapshot`) and point the baseline at the snapshot (`old_skill/`).

A subagent sees every installed skill. While a new skill is a draft, keep it out of the skill folders (draft it in the workspace) so the baseline can't load it. Once it's installed, the baseline brief must say not to read it, or run the baseline through `b4agent -p --no-skills` instead. Give writers disjoint output folders, or `isolation: "worktree"` when the task edits the repository.

**Assertions.** While the runs work, draft assertions per case: objectively checkable statements with descriptive names ("the total row sums column C", "no `#REF!` after recalc"). Check them with a script where you can; that's faster and repeatable across iterations. Don't force assertions on subjective qualities (style, design); those get the user's eye instead. Record the duration and tokens each run reports, if it does.

**Grading.** When all runs are in, grade each assertion with evidence (the file and line or value that passes or fails it). For a blind comparison, give an independent `general` agent the two outputs labelled A and B, without saying which used the skill, and ask which better meets the prompt and why. Then summarize per configuration: pass rate, time, tokens, and the difference. Look past the averages: an assertion that passes in both configurations tells you nothing about the skill; one that flips between runs of the same case is flaky; a win that costs three times the tokens is a trade-off for the user to judge.

**Review.** Show the user the outputs side by side (paths, or an HTML page in `/tmp` they can open) with the grades, and ask for comments per case. No comment means fine.

**Improve.** Generalize from the feedback instead of patching the examples: the skill will see far more prompts than these three. Explain the reason behind an instruction rather than adding capitals or rigid rules. Read the transcripts, not only the outputs: if every run wasted time on the same detour, cut the instruction that sent it there; if every run wrote the same helper script, bundle it in `scripts/`. Then run a new iteration with the same baseline, and stop when the user is happy, the feedback is empty, or the iterations stop improving.

## 2. Does it trigger?

The agent decides from the name and description alone whether to read a skill, and skips skills for tasks it can do in one easy step. So a trigger eval needs substantive prompts.

**Query set.** Write about 20 queries: 8-10 that should load the skill and 8-10 that shouldn't. Make them realistic, with paths, names, a little backstory, casual phrasing or typos. Vary the should-load ones: formal and casual, ones that never name the skill or file type, ones where another skill competes and this one should win. Make the should-not ones near misses that share keywords or concepts but need something else; an obviously unrelated query tests nothing. Let the user edit the set before you run anything. Save it as `[{ "query", "should_trigger" }]`.

**Measure.** Run each query in a fresh print-mode session with only the candidate skill added, and count a trigger when the agent reads the candidate's `SKILL.md`:

```bash
cand=<workspace>/candidate/<skill-name>      # a copy of the skill with the description under test
b4agent -p --mode json --no-skills --skill "$cand" "<query>" \
  | grep '"type":"tool_execution_start"' | grep -q "$cand/SKILL.md" && echo triggered
```

`--no-skills` drops the user's and project's skills; b4agent's bundled skills still load, which is realistic competition. To test against the user's full set as well, leave `--no-skills` out. A bundled skill with the same name shadows the candidate, so rename the candidate copy (folder and `name`) when tuning a bundled skill. Run each query three times and use the trigger rate. Use the model the user normally runs (`--model`) so the result matches what they'll see. Query runs can execute tools, so run them from a scratch directory (`cd` to an empty temp dir first) and stop a run once it has decided (the first few events show it).

**Tune.** Split the set 60/40 into train and held-out test, keeping both kinds of query in each half. Score the current description on both. Then iterate, up to about five times: look at the train failures only, write a better description (name the intents and the boundary rather than listing example phrases; stay within 1024 characters), and score it on both halves. Pick the description with the best **test** score, not train, so you don't overfit the queries you looked at.

**Apply.** Show the user the old and new description with both scores, and update the frontmatter once they agree.
