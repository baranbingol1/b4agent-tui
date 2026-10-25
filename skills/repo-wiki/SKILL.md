---
name: repo-wiki
description: Generate or update a static-HTML wiki for the current repository, with source citations, architecture diagrams and onboarding guides. Use when the user runs /repo-wiki or asks for a repository wiki, documentation site or architecture overview.
license: MIT
metadata:
  version: "1.0.0"
  author: Baran Bingöl
  homepage: https://github.com/baranbingol1/repo-wiki
---

# repo-wiki — repository wiki generator

Produce a static HTML wiki at `<repo-root>/repo-wiki/` that a newcomer can onboard
from and a reviewer can rely on. No build step, no server, no dependencies: the result
opens from `index.html` in any browser (file:// included) with sidebar navigation,
client-side search (Ctrl+K), light/dark themes, and Mermaid diagrams.

**The bar:** every claim cited to real files, every number computed, diagrams whose
nodes are actual file/function names, and zero filler. A wiki that paraphrases the
README has failed.

## Step 0 — Route the request

1. Find the repo root: `git rev-parse --show-toplevel`; if not a git repo, use the
   project root (where the primary manifest lives) and note it.
2. Route, in this order:
   - `repo-wiki/meta.json` exists, parses, and its `repo.commit` is reachable
     (`git cat-file -e <commit>`) → **update mode** (see
     [references/update-mode.md](references/update-mode.md)).
   - No usable local wiki, **but git history has one** → recover it as the update base.
     A previous run may have been committed and the folder later deleted, ignored, or
     lost to a clean checkout. Look for it before falling back to create mode:
     ```
     git log --oneline -n 50 -- repo-wiki/meta.json
     ```
     Walk those commits newest-first; for each, read `git show <c>:repo-wiki/meta.json`
     and take the first one that parses and whose `repo.commit` is reachable. Materialize
     that tree into a temp dir and use it as the base wiki:
     ```
     git -c core.autocrlf=false archive <c> repo-wiki | tar -x -C "$TMP"
     ```
     `core.autocrlf=false` matters: Git's Windows default rewrites the extracted pages
     to CRLF, every recorded hash mismatches, and the recovered wiki reads as entirely
     hand-edited. If all hashes mismatch at once, suspect the extraction, not a human.
     Announce it ("no local wiki; recovered the one committed at `<short>` as the
     incremental base"), then run **update mode** against `$TMP/repo-wiki`, writing
     output to `repo-wiki/`. Delete the temp dir when done. If nothing in history
     parses, fall through to create mode.
   - No `repo-wiki/` (or empty) and nothing in history → **create mode** (below).
   - `repo-wiki/` exists *without* a readable `meta.json` → it isn't ours or it's
     damaged. Do not clobber silently: move it to `repo-wiki.bak-<yyyymmdd>/`, tell
     the user, then try the git-history recovery above before create mode.
   - **Self-collision check:** if that `repo-wiki/` folder contains `SKILL.md` and
     `references/`, it is this skill's *source* installed at the output path. Never
     generate into it and never mix skill files into the wiki. Relocate the skill to
     the runtime's skills directory (e.g. `.claude/skills/repo-wiki/`), tell the user
     where it went and why, then run create mode into a clean `repo-wiki/`.
3. Arguments override routing. The user may pass arguments after the command (in
   Claude Code they arrive as: "$ARGUMENTS"):
   - `create` → force create mode (back up an existing wiki first as above)
   - `update` → force update mode (fall back to create if no wiki exists)
   - `rebuild` → full regeneration, preserving `settings` from the old `meta.json`
   - any other text → treat as steering notes (e.g. "focus on the auth flows",
     "the wiki is for new hires") and fold it into planning/scope for this run.
4. **Already-current short-circuit.** Once a base wiki is in hand (local or recovered),
   before doing any research:
   ```
   git status --porcelain
   git diff --shortstat <wikiCommit> HEAD -- . ':!repo-wiki/' ':!*.lock' ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml' ':!*.generated.*'
   ```
   If the tree is clean **and** that diff reports zero changed lines, print
   "wiki is already up to date at `<short-commit>`" and stop. Touch nothing — not
   `generatedAt`, not `meta.json`. This is the whole run. (`rebuild` still overrides it.)

   One exception: if the base was **recovered from git history** and `repo-wiki/` is
   missing from the working tree, restoring it *is* the work. Copy the recovered tree
   to `repo-wiki/` verbatim — no regeneration, no new `generatedAt` — and report
   "restored the wiki committed at `<short>`; it is current, nothing regenerated".
   Stopping with no folder on disk would leave the user worse off than when they asked.
5. Announce the chosen mode and (for update) the commit range in one line before
   working.

## Ground rules (both modes)

- **Evidence or silence.** Read the code before describing it. Cite `file:line-range`
  for specific claims. Mark anything unverifiable as *(unverified)* rather than guess.
- **Mirror the repo's structure and vocabulary.** Page names, section grouping, and
  diagrams use the project's real package/module/domain names — never generic labels.
- **Compute every number** (LOC, file counts, churn, contributors) with commands during
  recon; pin them to the commit. Never estimate.
- **Exclude noise**: vendored/generated/lock content (`node_modules/`, `vendor/`,
  `dist/`, `build/`, `.min.*`, lockfiles, generated protobufs…) from analysis and
  stats — count lockfiles/generated code separately if worth mentioning. Honor
  `settings.exclude` (config, below).
- **Never put secret values in the wiki.** Env var *names* and config *keys* are fine;
  values, tokens, and connection strings are not — even if found in the repo.
- **People are mapped, never scored.** Contributor names appear only on
  `maintainers.html` and in per-page bylines, always as names + areas + dates. No
  commits-per-person, no lines-per-person, no leaderboard, no email addresses,
  anywhere in the wiki. Derive names from the **default branch** (not the checked-out
  branch), merge identities, and filter bot accounts — full rules in
  [references/page-catalog.md](references/page-catalog.md).
- **Dates come from git.** History, eras, "last activity", and "first appeared" are
  read out of commit timestamps and tags. If the log can't tell you when something
  happened, say the date is unknown — never approximate one.
- **Parallelize when you can.** If the runtime offers subagents/parallel tasks
  (e.g. Claude Code's Task tool with Explore agents), fan research out; otherwise do
  the same briefs sequentially yourself. Quality bar is identical either way.
- **Date and commit honesty**: take `generatedAt` from a real clock
  (`date -u +%Y-%m-%dT%H:%M:%SZ`) and the commit from `git rev-parse HEAD` — never a
  guessed or rounded timestamp. The wiki is a snapshot pinned to that commit.

---

## CREATE MODE

### Phase 1 — Reconnaissance and the wiki plan

Build the repo picture with cheap commands before reading code deeply:

```
git rev-parse HEAD; git rev-parse --abbrev-ref HEAD
git remote get-url origin          # may fail — then repoUrl is null
git status --porcelain             # non-empty → record dirty: true
git ls-files                       # tracked inventory → extension histogram
git log --oneline | <count lines>  # commit count
git shortlog -sne --no-merges HEAD # contributors (names+emails; HEAD is required — without
                                   # a revision shortlog reads stdin and hangs)
git log --since="90 days ago" --pretty=format: --name-only   # churn (aggregate per path)
```

Then the history-and-ownership pass, which feeds `history.html`, `maintainers.html`,
the per-page bylines, and part of `by-the-numbers.html`:

```
git symbolic-ref --quiet refs/remotes/origin/HEAD    # default branch (fallbacks below)
git rev-parse --is-shallow-repository                # true → history pages degrade
git log --reverse --format="%h %ad %s" --date=format:%Y-%m | head -20   # the beginning
git tag --sort=creatordate --format="%(creatordate:short) %(refname:short)"
git log --format="%ad" --date=format:%Y-%m | sort | uniq -c             # commits/month
git log --diff-filter=A --format="%ad %h" --date=format:%Y-%m -- <path> | tail -1  # birth of a path
git log --diff-filter=D --format="%ad %h" --date=format:%Y-%m --name-only | head -80 # removals
git log --no-merges --shortstat --format="%h %ad %s" --date=short | <find big diffs>  # rewrites
git log --pretty=%b | <grep -i "co-authored-by:">   # bot co-authorship share
cat CODEOWNERS .github/CODEOWNERS docs/CODEOWNERS 2>/dev/null
```

Default branch fallback chain: `origin/HEAD` → `origin/main` → `origin/master` →
local `main`/`master` → `HEAD` (say which you used if it wasn't the first). Record the
resolved contributor map (person → subsystems → last month active, bots filtered,
identities merged) once here; every page reuses it rather than re-deriving.

Count lines of code per language: use `tokei`/`cloc` if installed; otherwise count
lines of tracked text files yourself (e.g. bash `git ls-files | xargs wc -l`,
PowerShell `git ls-files | Get-Content | Measure-Object -Line` per group) and say how
you measured. Then read, in this order: `README*`, `CONTRIBUTING*`, `AGENTS.md` /
`CLAUDE.md`, package manifests (`package.json`, `pyproject.toml`, `go.mod`, `*.csproj`,
…), CI workflows, `Dockerfile*` / IaC, `Makefile`/`justfile`/scripts, top-level
directory listing two levels deep. Identify entry points (bin/main/exports/routes),
subsystems, test layout, and the build/run/test commands.

If `repo-wiki.config.json` exists at the repo root, load it (schema in
**Configuration** below) and honor it.

Now write the **wiki plan** — the page table (section, title, file, purpose, candidate
sources) — following [references/page-catalog.md](references/page-catalog.md) for the
catalog, required content per page type, and size scaling (5–30 pages; never pad).
Keep the plan: it drives research, `nav.js`, and `meta.json`.

### Phase 2 — Deep research (fan-out)

One research task per planned page. Dispatch in parallel batches of 4–8 subagents when
available; otherwise execute sequentially. Each brief:

```
PAGE: <title> (<file>) — <purpose from the plan>
READ: <candidate sources>, their immediate callers/callees, and the tests covering them
ANSWER: the research questions for this page type (references/page-catalog.md)
RETURN as markdown notes:
  1. Claims — each with file path + line range evidence
  2. Key source files table (file → purpose)
  3. Key abstractions table (name → file → role)
  4. One Mermaid diagram sketch grounded in real identifiers
  5. Failure/edge-case behavior actually found in the code
  6. Gotchas and reviewer-relevant risks
  7. Glossary terms + 10–20 search keywords
  8. Open questions you could NOT verify (do not guess)
RULES: read files before claiming anything; paths relative to repo root; exact line
ranges; prefer "no evidence found" over speculation.
```

Spot-check returned notes: a note with no line references or with claims about files
that don't exist gets re-run, not patched over.

### Phase 3 — Write the pages

Convert notes into HTML pages exactly per
[references/html-authoring.md](references/html-authoring.md): copy
`assets/page.template.html` / `assets/index.template.html` from this skill's directory,
fill every `{{PLACEHOLDER}}`, and use the component markup (TLDR box, callouts, source
chips, diagram figures, inventory tables) as specified there. The main agent writes
pages itself for voice consistency; for very large wikis, fan out writing too but
enforce the markup contract strictly.

Cross-link related pages (the `{{RELATED}}` list + inline links). Keep each page
self-sufficient: a reader landing from search must not need another tab.

### Phase 3.5 — Screenshots (optional; skip by default)

Real screenshots of a running UI, embedded next to the prose that explains them. This
phase is **off unless asked for**. Run it only when one of these is true:

- the user asked for screenshots / images / visuals in this run's arguments, or
- `repo-wiki.config.json` sets `"media": true`, or
- that config declares an `apps` list whose entries have a `dev_command` plus a `url`
  or `port` (for web) or just a `dev_command` (for CLI/TUI).

Everything here is best-effort. **A failure at any step is a one-line warning in the
final report, never a failed run** — the wiki ships without images.

1. **Decide what is runnable.** From the config `apps` list, or (absent config) from
   what recon already found: dev/start scripts in `package.json`, a `Makefile` target,
   a Compose service, a console entry point. If nothing runnable exists — a library, an
   infra repo — skip the phase with "no runnable surface found; no screenshots".
2. **Pick a capture tool from what this machine already has.** In preference order:
   Playwright / Puppeteer if installed in the repo or globally; a headless Chrome/Chromium
   binary (`chrome --headless=new --screenshot=<out> --window-size=1280,800 <url>`); the
   agent's own browser-automation tool if the runtime provides one; an OS screenshot
   utility as a last resort. For CLI/TUI surfaces there is no browser at all — run the
   command with a fixed width and capture its **text** output. Never install a tool, and
   never add a dependency to the repo, to make this phase work: no tool, no phase.
   This skill depends on no external QA harness of any kind.
3. **Start what you need, and stop what you started.** Check the port first
   (`curl -sf http://localhost:<port>/`); if something already answers, use it and do
   not kill it later. Otherwise launch the `dev_command` in the background, poll the
   port for up to ~60s, and record the PID. Track exactly which processes you started;
   at the end of the phase stop those and only those.
4. **Capture a small set of real states** — 3–8 across the whole wiki, not per page.
   Aim for the screens the wiki already talks about (the routes listed on the frontend
   page, the commands on the CLI page). Save to `repo-wiki/assets/media/` with
   descriptive kebab-case names: `<app>-<state>.png`, `<app>-<state>.txt`.
5. **Filter hard.** Discard, and delete the file for, any capture showing: a login or
   auth screen, an error page or stack trace, a loading skeleton or spinner, or an empty
   state with no content. Never authenticate on the user's behalf, never enter
   credentials, and never capture a screen holding real data you would not put in a
   commit — a screenshot of a dashboard full of production values is a leak.
6. **Match and embed.** Assign each surviving capture to the pages whose prose it
   actually illustrates. **Max 3 pages per image; max 5 images per page.** Unmatched
   captures stay on disk with `"pages": []`. Embed with the `figure.shot` markup from
   [references/html-authoring.md](references/html-authoring.md), placed after the
   explaining paragraph. Edit the pages *before* Phase 4 hashes them.
7. **Record and clean up.** Build the `images` array for `meta.json` (path, app, flow,
   `capturedAt`, pages, `sizeBytes`), stop the servers you started, and carry any
   warnings into the final report.

### Phase 4 — Assemble the site

1. Copy `assets/style.css` and `assets/wiki.js` from this skill's `assets/` directory
   into `repo-wiki/assets/` **verbatim** (Claude Code exposes the skill directory; it
   is the folder containing this SKILL.md).
2. Generate `repo-wiki/assets/nav.js` and `repo-wiki/assets/search-index.js`
   (exact shapes in references/html-authoring.md).
3. Compute per-page sha256 hashes (after any Phase 3.5 edits) and write
   `repo-wiki/meta.json` last — it is the contract update mode depends on. Set
   `repoWiki` to `2` when the wiki carries `images` or page-level `contributors`.
4. If the repo has a `.gitignore` and the user hasn't said otherwise, leave
   `repo-wiki/` tracked (it's documentation); do not add ignore rules on your own.

### Phase 5 — Verify, then report

Run the **verification checklist** (below) and, when Python ≥ 3.8 is available,
`python scripts/validate.py <repo-root>/repo-wiki` from the skill directory — it must
pass. Fix and re-verify; do not ship a failing wiki.

Report to the user in a few lines: page count by section, the pinned commit, how to
open it (double-click `repo-wiki/index.html`, or `python -m http.server` inside
`repo-wiki/` for a local server), that diagrams need network once (or vendor
`mermaid.min.js` into `repo-wiki/assets/` for full offline), and that `/repo-wiki` later
will update incrementally. Then, in one line each, anything deliberately skipped and
why: `maintainers.html` (solo repo), `history.html` (no git / shallow), `fun-facts` or
`background` (no material), screenshots (not requested, or no runnable surface / no
tooling), plus any warning collected during Phase 3.5.

---

## UPDATE MODE

Follow [references/update-mode.md](references/update-mode.md) precisely. In short:
diff the base wiki's pinned commit against HEAD (plus uncommitted changes) — stopping
immediately if that diff is empty — map changed paths to pages through each page's
`sources`, fully rewrite affected pages from fresh research, add/remove pages for
new/dead subsystems, always refresh `index.html` stats + `history.html` +
`by-the-numbers.html` + `nav.js` + `search-index.js` + `meta.json`, detect hand-edited
pages by hash and never silently overwrite them, escalate to full rebuild when >~60% of
pages are affected or the structure shifted, and finish with the same verification gate
and a `base..head` change report. The base wiki is the local `repo-wiki/` when it is
usable, otherwise the copy recovered from git history in Step 0.

## Configuration — `repo-wiki.config.json` (optional, repo root)

```json
{
  "notes": ["Treat apps/legacy as frozen; packages/core is the active surface."],
  "pages": [{ "title": "Billing engine", "section": "Systems", "purpose": "..." }],
  "exclude": ["third_party/**", "**/*.generated.ts"],
  "maxPages": 24,
  "media": true,
  "apps": [
    { "name": "web", "dev_command": "npm run dev", "url": "http://localhost:3000" },
    { "name": "cli", "dev_command": "uv run mycli --help" }
  ]
}
```

- `notes` → steering context for planning and research (like reviewer notes to a
  documentarian).
- `pages` → when present, generate **exactly** these pages (plus `index.html`).
- `exclude` → glob patterns removed from analysis and stats.
- `maxPages` → overrides the size-based cap (still hard-capped at 30 + index).
- `media` → opt in to the optional screenshot pass (Phase 3.5). Default `false`.
- `apps` → what to run for that pass: `name`, `dev_command`, and `url` or `port` for
  web surfaces (omit both for CLI/TUI). A non-empty `apps` implies `media: true`.
Persist the effective values into `meta.json.settings` so updates inherit them.

## Verification checklist (the gate)

- [ ] `repo-wiki/` contains `index.html`, every planned page, `meta.json`,
      `assets/{style.css, wiki.js, nav.js, search-index.js}`.
- [ ] No literal `{{` placeholder remains in any generated file.
- [ ] Every file in `nav.js` exists; every page appears in `nav.js`,
      `search-index.js`, and `meta.json.pages` exactly once.
- [ ] Every internal `href` resolves to an existing file (+ every `data-path` cited
      exists in the repo at the pinned commit).
- [ ] Every page has: a lede, one TLDR box, h2 sections, ≥ 1 sources row; deep-dive
      pages have key-files and key-abstractions tables.
- [ ] Diagrams: ≥ 1 on index + architecture; all mermaid blocks non-empty; node labels
      are real identifiers.
- [ ] `index.html` stat strip numbers match recon output; footer stamp renders commit.
- [ ] `history.html` exists (git repo with a usable log) and every era/feature/removal
      row carries a real month+year; no page claims a date git didn't supply.
- [ ] `maintainers.html` exists (≥ 2 human contributors) and every deep-dive page opens
      with a byline — or both are deliberately absent for a solo repo, and the report
      says so.
- [ ] No per-person counts, rankings, or email addresses anywhere — including
      `by-the-numbers.html`.
- [ ] If Phase 3.5 ran: every `assets/media/` file is referenced by `meta.json.images`,
      every `<img src>` resolves, no login/error/loading/empty captures shipped, and
      every process the phase started was stopped.
- [ ] `scripts/validate.py` passes (when Python is available).

## Edge cases

- **Not a git repo**: proceed; `repo.*` fields are null; skip `history.html`,
  `maintainers.html`, bylines, and churn stats; warn that future runs will full-rebuild
  instead of incrementally update.
- **Solo repo** (≤ 1 human contributor after bot filtering and identity merging): skip
  `maintainers.html` and all bylines. Still write `history.html` — one person's repo
  still has eras. Say in the report that maintainers was skipped and why.
- **Dirty working tree**: proceed on the working tree, set `repo.dirty: true`, and
  note in the report that canonical wikis are best generated from a clean default
  branch.
- **Huge repo / monorepo**: prioritize by churn × entry points; sections per
  package/app; hard cap 30 pages and *say what was left out* on `index.html`.
- **No runnable surface** (pure library, infra repo): getting-started becomes
  import-and-use; skip inapplicable conditional pages — never write empty shells.
- **Shallow clone** (`git rev-parse --is-shallow-repository` → `true`): history-derived
  pages degrade. Skip `history.html` when the log has no usable dates at all; otherwise
  write it with an explicit note that the window starts at the graft point. Churn and
  "first appeared" figures state the truncation rather than pretending to be complete.
- **No screenshot tooling** on the machine: the media phase prints one warning and the
  run continues. Never install a browser, a driver, or a QA harness to satisfy it.
