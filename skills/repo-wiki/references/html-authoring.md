# HTML authoring — writing pages and generating the data files

How to turn research notes into `repo-wiki/*.html` pages plus the three generated data
files. Follow this exactly; `wiki.js` and `style.css` depend on the markup contract.

## Files in a finished wiki

```
repo-wiki/
├── index.html                  ← from assets/index.template.html
├── <slug>.html                 ← one per page, from assets/page.template.html
├── meta.json                   ← machine state (pure JSON; update mode depends on it)
└── assets/
    ├── style.css               ← COPIED VERBATIM from the skill's assets/ — never edit
    ├── wiki.js                 ← COPIED VERBATIM from the skill's assets/ — never edit
    ├── nav.js                  ← generated: window.REPO_WIKI = {...}
    ├── search-index.js         ← generated: window.REPO_WIKI_SEARCH = [...]
    └── media/                  ← optional: captured screenshots / TUI snapshots
```

`assets/media/` only exists when the optional capture pass ran (SKILL.md Phase 3.5).
Nothing else may live at the wiki root — no second top-level tree for images, no
scratch files.

Instantiate pages by copying the template and replacing every `{{PLACEHOLDER}}` (the
templates document each one in their header comment). Leave ids, asset paths, and
structure untouched — `wiki.js` builds the sidebar, breadcrumbs, TOC, search, theme
toggle, and footer stamp at runtime from `nav.js`/`search-index.js`, so pages contain
**content only**. Verify no literal `{{` remains in any written file.

## Writing rules (non-negotiable)

1. **Every claim is grounded.** Each major section (h2) ends with a sources row citing
   the files (with line ranges when the claim is specific). Target ≥ 5 citations per
   page. A page with zero citations is broken.
2. **No filler.** Banned: "modern best practices", "robust and scalable", "plays a
   crucial role", restating a file name as its own description. If a sentence would be
   true of any repo, delete it.
3. **Numbers are computed, never invented.** LOC, file counts, churn — run the commands
   during recon and reuse the results. State the commit they were measured at.
4. **Honest gaps.** Could not verify a behavior? Write "(unverified)" or "no evidence
   found of X". Never guess silently.
5. **Two audiences.** Newcomer first (mental model, where to start), reviewer second
   (invariants, traps, hotspots — use `callout review`).
6. **HTML-escape** `&` `<` `>` in prose and code blocks (`&amp;` `&lt;` `&gt;`).
   Exception: inside `<pre class="mermaid">`, write mermaid source raw (arrows `-->`
   are fine; avoid literal `<` except `<br/>` in labels).
7. **Links between pages** are relative: `<a href="./architecture.html">`. Anchors:
   h2/h3 get ids from `wiki.js` by slugifying the text (lowercase, non-alphanumerics →
   `-`); when deep-linking, set the id explicitly on the heading to be safe:
   `<h2 id="failure-handling">Failure handling</h2>`.

## Component markup

### Source citation chips

Inline, after a claim or grouped in a sources row. `data-lines` optional
(`"10-42"` or `"10"`). `wiki.js` turns chips into links to the repo host (pinned to
the generation commit) when `repoUrl` is set; keep the visible text as fallback.

```html
<p class="sources">
  <code class="src" data-path="src/indexer.py" data-lines="301-377">src/indexer.py:301-377</code>
  <code class="src" data-path="src/db.py">src/db.py</code>
</p>
```

Use sparingly inline too: `... retries are bounded <code class="src" data-path="src/worker.py" data-lines="88-104">src/worker.py:88-104</code>.`

### Active contributors byline (deep-dive pages)

The `{{BYLINE}}` placeholder sits between the `<h1>` and the lede. Fill it with exactly
this markup on deep-dive and domain pages, or with an **empty string** everywhere else
(solo repos, `Start here` pages, glossary, Reviewer's-desk pages). Leaving the literal
`{{BYLINE}}` in a page is a validation error like any other placeholder.

```html
<p class="byline"><span class="byline-label">Active contributors</span> ada, grace</p>
```

It is a `<p>`, never a heading — `wiki.js` builds the TOC from `h2`/`h3`, so a heading
here would poison the on-this-page rail. Names only: first names or GitHub usernames,
no `@`, no email, no counts, no ordering that implies ranking (alphabetical or
most-recent-first, stated the same way on every page). Derivation rules live in
[page-catalog.md](page-catalog.md#contributors-and-ownership--how-to-derive-names-used-by-maintainers--bylines).

### TLDR box (one per page, required, directly after the lede)

```html
<div class="tldr">
  <div class="tldr-label">If you only read one thing</div>
  <p>The single paragraph that matters. Name the invariant, link the next page.</p>
</div>
```

### Callouts

```html
<div class="callout">          <!-- variants: (none) = note, warn, review -->
  <div class="callout-icon">◆</div>   <!-- note ◆ · warn ▲ · review ⊙ -->
  <div>
    <span class="callout-title">Note</span>   <!-- Note · Watch out · Reviewer note -->
    <p>Body. Keep to 1–3 sentences.</p>
  </div>
</div>
```

`callout review` is the reviewer lens: invariants, "ask for a test before approving",
risk notes. Use ≥ 1 on architecture and deep-dive pages where justified.

### Diagrams (Mermaid)

```html
<figure class="diagram">
  <pre class="mermaid">graph LR
    CLI["cli.py"] --> Indexer["indexer.py"]
    Indexer --> DB[("index.sqlite")]</pre>
  <figcaption>Write ordering during an index run.</figcaption>
</figure>
```

Style rules (DeepWiki-grade):
- Node labels are **real code identifiers** — file names, function signatures, table
  names. Two-line labels with `<br/>`: `Build["build.js<br/>Rollup pipeline"]`.
- Group layers with `subgraph Name["Human label"] ... end`.
- Pick the right type: `graph TD/LR` for structure and dependencies,
  `sequenceDiagram` for flows/protocols, `stateDiagram-v2` for lifecycles, `erDiagram`
  for data models, `xychart-beta` for stat bars (by-the-numbers page).
- ≤ 12 nodes per diagram; split rather than cram. Always add a `<figcaption>`.
- 1–3 diagrams per page where they genuinely explain something; every diagram must be
  derivable from cited code, not aspiration.
- Rendering: `wiki.js` loads Mermaid from `assets/mermaid.min.js` if present, else CDN;
  offline with no vendored copy, readers see the source in a collapsible block — fine.

### Screenshots and TUI snapshots (only from the optional capture pass)

Never hand-write these — they exist only when SKILL.md Phase 3.5 actually captured a
real running surface. A screenshot of something you did not run is a fabrication.

```html
<figure class="shot">
  <img src="./assets/media/web-sessions.png" alt="Sessions list in the web dashboard"
       loading="lazy" width="1280" height="800">
  <figcaption>Session list at <code>/sessions</code> — one row per synced session.</figcaption>
</figure>
```

Text/TUI captures embed as a `<pre>` inside the same figure, so the two look alike:

```html
<figure class="shot">
  <pre class="tui">$ acme-search query "vector store"
  1  src/acme_search/vector_store.py:88   0.81
  2  src/acme_search/indexer.py:301       0.74</pre>
  <figcaption>Ranked output of <code>acme-search query</code>.</figcaption>
</figure>
```

Rules: `figure.shot` (not `figure.diagram` — that class carries the mermaid zoom
chrome). Every image needs a real `alt` describing what the reader sees, and a
`figcaption` naming the route/state and what it demonstrates. Escape HTML entities
inside `pre.tui`. Place a shot after the prose that explains it, never before the `<h1>`
and never as the first element of a page. **Max 5 shots per page; max 3 pages per
shot.** Paths are always relative (`./assets/media/…`) so `file://` keeps working.

### Tables

Plain `<table>` with `<thead>`/`<tbody>` (wiki.js adds the scroll wrapper). Use the
`num` class for right-aligned numeric columns: `<td class="num">5,214</td>`. Standard
inventory tables: Key source files (file → purpose), Key abstractions (name → file →
role), flows, config keys, endpoints, churn.

### Code blocks

```html
<pre><code class="language-bash">uv sync
uv run pytest</code></pre>
```

Always set `language-*` (bash, python, ts, json, yaml, text…) — it becomes the header
label. Commands must be real ones from the repo's docs/CI; escape HTML entities.

### Index-page extras

Stat cell: `<div class="stat"><div class="stat-value">24.1k</div><div class="stat-label">lines tracked</div></div>`
Card: `<a class="card" href="./architecture.html"><div class="card-kicker">Start here</div><h3>Architecture</h3><p>One-line hook.</p></a>`
Group cards by section. Card `<h3>`s are automatically excluded from the TOC.

## Generated data files

### `assets/nav.js` — exact shape

```js
/* Generated by repo-wiki — do not hand-edit */
window.REPO_WIKI = {
  project: "acme-search",
  tagline: "One-sentence description.",
  repoUrl: "https://github.com/org/repo",   // null when no remote; strip .git
  branch: "main",                            // null when not a git repo
  commit: "e4a26f2480ad3c347333c66b5af747ec5195f1ba",  // full sha; null if none
  generatedAt: "2026-06-10",
  generator: "repo-wiki",
  nav: [
    { section: "Start here", items: [
      { title: "Overview", file: "index.html" },
      { title: "Architecture", file: "architecture.html" }
    ]},
    { section: "Systems", items: [ /* ... */ ] }
  ]
};
```

Order = sidebar order = plan order. `index.html` is always the first item. Numbering
(`1.1`, `2.3`) is rendered automatically from position.

### `assets/search-index.js` — exact shape

```js
/* Generated by repo-wiki — do not hand-edit */
window.REPO_WIKI_SEARCH = [
  {
    file: "architecture.html",
    title: "Architecture",
    section: "Start here",
    summary: "The two-store design: SQLite as truth, vectors as a rebuildable index.",
    headings: [
      { t: "Component map", a: "component-map" },
      { t: "Failure handling", a: "failure-handling" }
    ],
    keywords: ["sqlite", "qdrant", "invariant", "indexer.py"]
  }
];
```

One entry per page (including index.html). `headings` lists the page's h2/h3 with
their anchor ids (`a` = the slugified heading or the explicit id you set). `keywords`:
10–20 lowercase terms a developer would type — file names, domain words, commands,
acronyms. `summary` = the page lede.

### `meta.json` — exact shape (pure JSON, machine-read by update mode)

```json
{
  "repoWiki": 2,
  "generator": "repo-wiki",
  "generatedAt": "2026-06-10T14:30:00Z",
  "repo": {
    "remote": "https://github.com/org/repo",
    "branch": "main",
    "defaultBranch": "main",
    "commit": "e4a26f2480ad3c347333c66b5af747ec5195f1ba",
    "dirty": false
  },
  "settings": { "exclude": [], "notes": [], "media": false },
  "pages": [
    {
      "file": "architecture.html",
      "title": "Architecture",
      "section": "Start here",
      "summary": "The two-store design…",
      "sources": ["src/acme_search/indexer.py", "src/acme_search/db.py", "src/acme_search/"],
      "contributors": ["ada", "grace"],
      "hash": "sha256:<hex of the page file's bytes>"
    }
  ],
  "images": [
    {
      "path": "assets/media/web-sessions.png",
      "app": "web",
      "flow": "sessions-list",
      "capturedAt": "2026-06-10T14:22:05Z",
      "pages": ["web-dashboard.html"],
      "sizeBytes": 145230
    }
  ]
}
```

- `generatedAt`: the real current UTC time from `date -u +%Y-%m-%dT%H:%M:%SZ`
  (PowerShell: `(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")`).
  Never a guessed, rounded, or midnight-placeholder timestamp.
- `repo.*`: from `git remote get-url origin` (normalize to https, strip `.git`),
  `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD`, `git status --porcelain`
  (non-empty → `dirty: true`). All `null` outside a git repo.
- `sources`: the files and directory prefixes (trailing `/`) this page documents —
  update mode maps changed paths to pages through these. Be generous but real.
- `hash`: sha256 of the final written HTML file (PowerShell `Get-FileHash`, or
  `shasum -a 256`). Update mode uses it to detect hand-edited pages.
- `settings`: carry user preferences across runs (merge from `repo-wiki.config.json`
  if the repo has one), including `media` so a later update knows whether captures were
  in play.
- `contributors`: per page, the same names printed in that page's byline, in the same
  order. Omit the key on pages with no byline. Names only — the schema has no place for
  counts, and adding one is a privacy regression, not an enhancement.
- `images`: one entry per captured file that survived filtering, even if it matched no
  page (`"pages": []` — it stays on disk for manual curation). `path` is relative to the
  wiki root; `capturedAt` is a real UTC clock reading; `sizeBytes` is the file's actual
  size. Omit the whole key when no capture pass ran.

**Schema version.** Write `"repoWiki": 2` whenever the wiki carries `images` or any
page-level `contributors`; a wiki with neither may stay at `1`. Update mode reads both:
a v1 wiki is a valid base and is upgraded in place (bylines and new pages get added on
the next run). Anything above 2, or unparseable, means rebuild.

## Assembly order

1. Copy `style.css` + `wiki.js` from the skill's `assets/` into `repo-wiki/assets/`.
2. Write all page HTML files.
3. Optional capture pass (SKILL.md Phase 3.5): write `assets/media/*` and edit the
   matched pages to embed their figures. Pages must be final *before* hashing.
4. Generate `nav.js` and `search-index.js` from the final plan + written headings.
5. Compute hashes; write `meta.json` last (including `images` if step 3 ran).
6. Run the verification pass (see SKILL.md checklist and `scripts/validate.py`).

Hash order matters: `meta.json` records the sha256 of the bytes actually on disk. If
you embed an image into a page after hashing it, update mode will read that page as
hand-edited and refuse to touch it.
