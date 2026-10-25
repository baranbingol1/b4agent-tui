# Page catalog — planning the wiki

How to decide which pages a repository needs, what each page must contain, and how to
scale the plan to repo size. The output of planning is the **wiki plan**: an ordered list
of `{section, title, file, purpose, candidate sources}` that drives research fan-out,
`nav.js`, `search-index.js`, and `meta.json`.

## Scaling rules

Count tracked, non-vendored lines first (recon phase). Then size the wiki:

| Repo size (code LOC) | Pages | Shape |
| --- | --- | --- |
| < 3k or < 30 files | 5–7 | Merge aggressively: Architecture + Codebase tour as one page; Testing + CI as one page |
| 3k – 15k | 8–12 | All core pages, 2–4 system deep dives |
| 15k – 80k | 12–20 | Full taxonomy, one deep dive per real subsystem |
| > 80k or monorepo | 20–30 (hard cap 30) | Group deep dives by package/app; one "tour" page per package |

Never pad. A page that would say nothing non-obvious must not exist — fold it into a
neighbor. If `repo-wiki.config.json` specifies `pages`, generate exactly those pages and
no others; if it sets `maxPages`, respect it.

**The budget is shared.** `history.html`, `maintainers.html`, `fun-facts.html` and
`background.html` are pages like any other: they consume slots from the same 5–30
budget, and the cap of 30 (+ `index.html`) is hard. On a small repo that means merging
or skipping deep dives to make room for `history.html`, not exceeding the cap — and
skipping `fun-facts`/`background` outright when they would be thin. Never pad to fill
the budget, and never overflow it to fit a flavor page.

**Sections are the sidebar groups.** Default section order (omit empty ones):
`Start here` → `Systems` → domain/feature sections → `Interfaces` → `Data` →
`Operations` → `Contributing` → `Reviewer's desk`.

Plan deep-dive pages from the repo's **actual structure** (real packages, services,
pipelines — named after them), not from this catalog's generic labels. The catalog tells
you what kinds of pages exist; the repo tells you which ones and what they're called.

---

## Core pages (every wiki)

### Overview — `index.html` (uses `index.template.html`)

The 60-second orientation. Required content:

- **Tagline + kicker**: what the project is in one evidence-based sentence; kicker names
  the shape (`Python CLI · semantic code search`, `TypeScript monorepo · 4 packages`).
- **Stat strip**: 4–6 real numbers — lines tracked, files, dominant language %, test file
  count, commits, contributors. Compute them; never estimate.
- **TLDR**: the one paragraph a newcomer must read; name the 2–3 load-bearing concepts
  and link the next pages to read.
- **What it does**: capabilities mapped to entry points, with source chips.
- **System diagram**: one small Mermaid graph — the 30-second mental model (≤ 10 nodes).
- **Repository shape**: annotated top-level tree (plain `<pre>` code block, one comment
  per line).
- **Browse the wiki**: card grid, one card per page, grouped by section (`{{CARDS}}`).

Research questions: What problem does this solve? What are the entry points
(main/exports/routes/commands)? What is the tech stack and how is it built? What would a
maintainer say this project is, based on README vs. what the code actually does (note
mismatches!)?

### Getting started — `getting-started.html`

Install → run → test, with commands that actually work. Source them from
`package.json`/`pyproject.toml`/`Makefile`/`justfile`/CI workflows — cite where each
command comes from. Required: prerequisites (with why — "git, because `git_utils.py`
shells out to `git ls-files`"), dev install, run-from-source, test commands, common
checks. Mark anything you could not verify by reading config as *(unverified)*. If the
project has no runnable surface (a library), show the import-and-use path instead.

### Architecture — `architecture.html`

The high-level map and the reasons behind it. Required sections:

- **Component map**: Mermaid graph of the main modules; arrows are call/data
  relationships; nodes are real file/module names.
- **Key invariants / design decisions**: the rules that must not be broken, each with
  evidence and a `callout review` block for the most load-bearing one.
- **Main runtime flows**: table of flow → implementation files → state touched; add a
  `sequenceDiagram` for the most important flow.
- **Where complexity concentrates**: the largest/most-coupled files and why they matter.

Research questions: What are the layers/boundaries? What owns state? What is the
write/read path? What would break if reordered? What did the authors document
(ADRs/design docs) vs. what the code shows?

### Codebase tour — `codebase-tour.html`

Directory-by-directory walkthrough mirroring the actual tree. For each significant
directory: what lives there, the 2–3 files to read first, naming conventions observed.
End with "where to put new code" guidance derived from observed patterns or contributor
docs. This page anchors the user requirement that the wiki *keeps the project structure
in mind* — its structure must mirror the repo's.

### Glossary — `glossary.html` (skip for tiny repos)

Table: term → meaning → main source file(s). Only domain terms the code actually uses
(type names, table names, concepts). 8–20 rows.

---

## Deep-dive pages (`Systems` and domain sections)

One page per real subsystem (pipeline, service, package, layer). Naming: use the repo's
own vocabulary (`indexing-pipeline.html`, `payment-service.html`). Required skeleton:

0. **Active contributors byline** — the line directly under the `<h1>`, before the lede:
   `Active contributors: ada, grace`. Derived per subsystem from CODEOWNERS + default-branch
   `git log` over that subsystem's paths (rules in **Contributors and ownership** below).
   Omit the line entirely when the repo is solo or the subsystem has no attributable
   history — never print an empty or "unknown" byline. Core `Start here` pages, glossary,
   and Reviewer's-desk pages do not carry a byline.
1. Lede = purpose and scope (what this subsystem owns, what it explicitly does not).
2. **Key source files** table: file → purpose.
3. **Key abstractions** table: name → file → role (types, classes, interfaces).
4. **How it works**: prose + one Mermaid diagram (graph for structure, `sequenceDiagram`
   for protocols/flows, `stateDiagram` for lifecycles).
5. **Failure handling / edge cases**: what happens when things go wrong (find the actual
   error paths; cite them).
6. Cross-links to sibling systems.

Every section ends with a sources row. If you cannot fill section 5 with evidence, say
"no explicit error handling found in X" — that is itself a finding.

---

## Conditional pages (include when the repo has the thing)

| Page | Include when | Must contain |
| --- | --- | --- |
| `api-surface.html` | HTTP/RPC/GraphQL endpoints exist | Route table (method, path, handler file:line, auth), request/response shapes, versioning |
| `cli-reference.html` | CLI with subcommands | Command table → implementation, flags, exit codes |
| `data-model.html` | DB schema/ORM models/migrations | Entity table, `erDiagram` if relations exist, migration strategy, where writes happen |
| `frontend.html` | UI code | Route/screen inventory, state management, component conventions, design tokens |
| `configuration.html` | Config files/env vars | Every key: name → type → default → effect → source file. The single most-thanked page; be exhaustive |
| `testing.html` | Tests exist | Test layout, how to run each suite, fixtures/mocking patterns, what is *not* covered |
| `ci-and-releases.html` | CI workflows | Per-workflow table (trigger → jobs → purpose), release/versioning flow, secrets used (names only — never values) |
| `deployment.html` | Dockerfiles/IaC/k8s | Runtime topology, images built, infra entry points |
| `security-notes.html` | Auth/crypto/trust boundaries | Where authn/authz happens, secret handling, input validation chokepoints, trust boundaries diagram |
| `dependencies.html` | Always possible; include for medium+ | Direct deps table: package → version → why it's used (grep for imports) — flag unused/duplicated ones |
| `development-workflow.html` | Contributor docs or evident conventions | Local loop, branch/PR checks, code style, "where new code goes" |

---

## Reviewer's desk (the differentiator — always include for small+)

Order inside the section (omit the ones that don't apply):
`review-guide` → `by-the-numbers` → `cleanup-opportunities` → `background` →
`history` → `fun-facts` → `maintainers`. **`maintainers.html` is always last**, in the
section and in the whole sidebar.

### Review guide — `review-guide.html`

Written for someone about to review a PR in this repo. Required:

- **Invariants to protect**: each as a `callout review` with the breaking condition and
  the test that guards it (or "unguarded — ask for a test").
- **Hotspots**: top files by churn (`git log --name-only` aggregation) × size — the
  table of "where bugs live".
- **Traps**: gotchas found during research (silent behaviors, ordering requirements,
  platform quirks), each cited.
- **Review checklist**: 5–10 repo-specific questions a reviewer should ask.

### By the numbers — `by-the-numbers.html`

Quantitative snapshot, AutoWiki style. Open with provenance: "Data collected on
<date> from tracked files at `<commit>`", plus exclusions (vendored/generated paths).
Content: LOC by language (table + optional `xychart-beta` bar chart), files by kind
(source/tests/config/docs/CI), churn table (commits per path, last 90 days), largest
files with why-it-matters notes, contributor count. State methodology caveats honestly
("lower bound — squash merges hide co-authors").

**No per-person metrics on this page.** Report the *count* of distinct human
contributors (and, if useful, bot-attributed commit share as a percentage) — never a
commits-per-author table, a lines-per-person figure, or any ranking of people. This
page is about the codebase; people belong on `maintainers.html`, which maps ownership
without scoring anyone. If a commits-by-author table exists from an earlier run,
delete it during the rewrite.

### Cleanup opportunities — `cleanup-opportunities.html` (medium+ repos)

TODO/FIXME/HACK inventory (count, table of notable ones with file:line), complexity
hotspots with maintenance notes, dead-code candidates (exports nothing imports — verify
before claiming). Tone: factual maintenance notes, not criticism.

### History — `history.html` (required whenever the repo is git with a usable log)

The narrative of how this codebase got here — what changed and when. Not a technical
reference (that is architecture) and not a snapshot (that is by-the-numbers).

Include it for **every git repository whose log carries dates**. Skip it only when:
the project is not a git repo, or the clone is shallow/grafted so commit dates and
ancestry are unusable (`git rev-parse --is-shallow-repository` → `true`,
or `git log` yields fewer than ~10 dated commits). When you skip it, say why in the
run report; do not silently drop it. A young repo gets a short honest history page
("two eras, both in 2026"), not no page.

Every era, milestone, and feature date carries a **month and year** derived from real
git data — `git log --date=format:%Y-%m` timestamps, `git tag` dates, first/last commit
touching a path. Never invent or round a date, and never date something you could not
measure.

Required sections:

- **Eras** — 3–8 phases, each with a date range, a short narrative, and the commits or
  tags that define it (cite short hashes). Derive boundaries from real signals: tag
  dates, directory creation dates (`git log --diff-filter=A -- <path>`), bursts in
  commit rate, build-system or dependency swaps, contributor onboarding.
- **Longest-standing features** — code that has survived the most change and is still
  live. Per row: what it is, first commit month, number of commits since, and the file
  it lives in today. Find with `git log --diff-filter=A --format=%ad --date=format:%Y-%m -- <path> | tail -1`.
- **Deprecated or removed features** — only when evidence exists (deleted directories,
  `@deprecated` markers, removed routes/commands, README sections that vanished). Per
  row: what it was, when it appeared, when it went, and what replaced it. If the log
  shows no removals, write one line saying so and move on — do not manufacture rows.
- **Major rewrites and migrations** — large changes that touched many files at once.
  Per entry: what existed before, what replaced it, when, and the commit(s). Find with
  `git log --shortstat`, merge commits with large diffstats, and branch names containing
  `migrat`/`rewrite`/`refactor`.
- **Growth trajectory** — when the repo gained packages, apps, top-level directories, CI,
  tests, or its first release tag; how commit volume moved across the eras.

Research questions: What did the first 20 commits build? What is the oldest file still
imported? Which tags exist and what did each one ship? What directories appeared or
disappeared, and when? Where does the commit graph change pace, and what happened there?

Speculation rule: when the *why* is not in the evidence, hedge in plain words
("appears to have been replaced by", "likely because") — never assert a motive the log
does not support, and never attach a date to a guess. Prefer "the reason is not
recorded in the history" over a plausible story.

### Fun facts — `fun-facts.html` (conditional — only with real material)

3–5 genuinely repo-specific items, each with evidence. Good candidates: the oldest
surviving file or function (`git log --diff-filter=A --reverse`), where the project or
an internal tool got its name (README, early commits, comments), the oldest unresolved
TODO/FIXME with its file:line and age, the longest source file, the dependency with the
most version bumps, an odd constant or easter egg that is actually in the code.

Skip the page entirely when the repo has nothing interesting to say — three flat facts
about a young library is padding, and padding is worse than absence. Never invent
lore, and never repeat what `by-the-numbers` or `history` already covers.

### Background — `background.html` (conditional — only when the *why* is documented)

Design rationale, pitfalls, and migration context: the decisions a newcomer would
otherwise re-litigate. Include this page **only when the repo actually explains its own
reasoning** — ADRs (`docs/adr/`, `docs/decisions/`), design documents, RFCs, a
`DESIGN*.md`, long comment blocks or docstrings that justify a choice, or commit
messages that argue a trade-off. Cite each rationale to where it is written.

Sections when the material supports them: **Design decisions** (decision → rationale →
where it is recorded → what it constrains today), **Pitfalls / danger zones** (the
things that have bitten people, with the code that guards against them), **Migration
context** (what the codebase is halfway through moving between, and which side new code
should be written on).

If the only "why" you can find is your own inference from the code, that belongs in
`architecture.html` as a design decision — not here. No documented rationale, no page.

### Maintainers — `maintainers.html` (conditional — skip for solo repos; always last)

Who to ask about what. A mapping page, not a scoreboard.

Skip the page entirely when the repo has **≤ 1 distinct human contributor** after
identity merging and bot filtering (see below). A solo project's answer is "the author",
and a one-row table is noise.

Required content:

- **Ownership table**: one row per subsystem/page-worthy area. Columns: Subsystem →
  Official owners (from CODEOWNERS; drop this column if there is no CODEOWNERS) →
  Recent contributors (2–3 names) → Last activity (month/year of the newest commit
  touching those paths).
- **How to read this table**: one short paragraph saying the git-derived names are
  "who touched it most recently", not an assignment of responsibility, and pointing at
  CODEOWNERS (or its absence) as the authoritative source.
- **Coverage gaps**: paths with no CODEOWNERS entry and no commit in the last N months —
  the areas where nobody obvious can answer a question. This is the most useful row set
  on the page; do not omit it when it exists.

Never include a per-person commit count, a lines-of-code-per-person figure, a ranking,
or any wording that compares people. Names, areas, and dates only.

### Contributors and ownership — how to derive names (used by maintainers + bylines)

Both `maintainers.html` and the per-page bylines come from the same computation. Do it
once during recon, reuse it everywhere.

1. **Resolve the default branch, and query it — not the current branch.** Feature
   branches skew attribution toward whoever is working on them.
   `git symbolic-ref --quiet refs/remotes/origin/HEAD` → strip to a branch name; fall
   back to `origin/main`, then `origin/master`, then the local `main`/`master`, then
   `HEAD` (and say so in the report when you had to fall back).
   Then, per subsystem path: `git log <default-branch> --no-merges --format="%an|%ae|%ad" --date=format:%Y-%m -- <path>`.
2. **Filter bots** before counting anything. Drop authors and co-authors whose name ends
   in `[bot]`, and the known agent/service identities: `dependabot`, `github-actions`,
   `renovate`, `copilot`, `factory-droid`, `devin`, `cursoragent`, `amp`, plus any
   address at `noreply@anthropic.com`, `users.noreply.github.com` belonging to a `[bot]`
   account, or a CI service account. Machine accounts that are clearly hosts, not
   people (`Ubuntu <azureuser@…internal.cloudapp.net>`), are bots for this purpose.
   Bot-attributed *share* is a legitimate `by-the-numbers` statistic; bot *names* are
   not people to contact.
3. **Merge identities** by email first, then by obvious name equivalence
   (`baran` and `baranbingol1` at the same address are one person). Honor `.mailmap`
   when the repo has one. Pick one display form per person — a GitHub username or a
   first name, no `@`, no email address in the wiki.
4. **Rank by recency, then volume**: the 2–3 people whose most recent commits touch the
   subsystem. A person who wrote it two years ago and left is not who you ask today;
   note them in `history.html` instead if it matters.
5. **Privacy floor** (applies to every page): names, areas, dates. No counts per person,
   no ranking, no email addresses, no "top contributor" framing anywhere in the wiki.

Both features degrade honestly: no git → no maintainers page and no bylines; shallow
clone → say the attribution window is truncated rather than presenting a partial
history as complete.

---

## Page planning output format

Produce the plan as a table before researching (and keep it for `meta.json`):

| # | Section | Title | File | Purpose (1 line) | Candidate sources |
| --- | --- | --- | --- | --- | --- |
| 1.1 | Start here | Overview | index.html | Orientation + stats + map | README.md, package manifests |
| 2.1 | Systems | Indexing pipeline | indexing-pipeline.html | How files become vectors | src/indexer.py, src/chunking.py |

Rules: `index.html` is always 1.1. Kebab-case file names. Every planned page lists ≥ 1
candidate source path (a file or a directory prefix ending in `/`) — these become the
research brief and, later, `meta.json` `sources` used by update mode.

Plan order **is** sidebar order. Full default sequence:

```
Start here        index · getting-started · architecture · codebase-tour · glossary
Systems           one page per real subsystem (repo's own names)
<domain sections> feature/app/package groupings the repo actually has
Interfaces        api-surface · cli-reference · frontend
Data              data-model · configuration
Operations        deployment · ci-and-releases · security-notes · dependencies
Contributing      development-workflow · testing
Reviewer's desk   review-guide · by-the-numbers · cleanup-opportunities ·
                  background · history · fun-facts · maintainers
```

Omit empty sections and inapplicable pages; never reorder to group childless pages
together. History-derived pages (`history`, `maintainers`) list their real inputs as
`sources` too — the paths whose churn they describe, plus `CODEOWNERS` when it exists —
so update mode can reason about them like any other page. `history.html` and
`by-the-numbers.html` are additionally always-refreshed on update (see
[update-mode.md](update-mode.md)).
