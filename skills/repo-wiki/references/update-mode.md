# Update mode — incremental refresh algorithm

Goal: bring an existing `repo-wiki/` up to date with the least work that keeps every
page truthful. Update mode rewrites *affected pages completely* (never patch prose
piecemeal — partially-updated pages drift into lies) but leaves unaffected pages
byte-identical except for shared chrome data (`nav.js`, `meta.json`).

## 1. Load state and decide feasibility

1. Read `repo-wiki/meta.json`. If it is missing or unparseable, do **not** jump
   straight to create mode — first try to recover a base wiki from git history
   (step 1a). Back up any stray non-empty `repo-wiki/` contents to
   `repo-wiki.bak-<date>/` before writing anything.
2. `meta.json.repo.commit` is the **base commit**. If null (not a git repo at
   generation time) → full rebuild, same announcement.
3. Verify the base commit exists: `git cat-file -e <commit>` — if it fails (rebase,
   shallow clone, history rewrite), try `git merge-base <commit> HEAD`; if that also
   fails → full rebuild with a note.
4. `meta.json.repoWiki` of `1` or `2` is usable. A v1 base is upgraded in place: this
   run adds whatever v2 requires (bylines, `contributors`, `history.html`,
   `maintainers.html` when applicable) as part of normal page work. Anything higher, or
   a marker you don't recognize, → full rebuild.

### 1a. Recovering a base wiki from git history

A committed wiki survives a deleted folder, a `.gitignore` change, or a fresh clone.
Before declaring "no base wiki", look for one:

```
git log --oneline -n 50 -- repo-wiki/meta.json
```

Walk those commits newest-first. For each, `git show <c>:repo-wiki/meta.json`; take the
first that parses **and** whose `repo.commit` is reachable (`git cat-file -e`). That is
your base. Materialize the whole tree into a temp dir, and read pages from there for
the rest of this run:

```
TMP=$(mktemp -d) && git -c core.autocrlf=false archive <c> repo-wiki | tar -x -C "$TMP"
```

**`core.autocrlf=false` is not optional.** With Git's Windows default (`autocrlf=true`)
`git archive` rewrites every extracted page to CRLF, so all recorded sha256 hashes
mismatch and the hand-edit check in §4 flags the entire wiki as human-edited — the
recovery silently degrades into "refuse to touch anything". Extract with line endings
untouched, then verify: if *every* hash mismatches, suspect the extraction before
believing a human rewrote all the pages at once.

The base commit for diffing is the `repo.commit` recorded *inside* that recovered
`meta.json` — the commit its content describes — not `<c>`, the commit that stored it.
Copy unchanged pages out of `$TMP/repo-wiki/` exactly as you would from a local wiki,
regenerate the affected ones, and delete `$TMP` when the run finishes (including on
failure). Hand-edit detection still applies: the recovered `hash` values describe the
recovered files, so a page whose committed bytes match its recorded hash is safe to
overwrite.

Say which commit you recovered from, and note that pages hand-edited *after* that
commit and never committed are gone — this is a recovery, not a merge. If nothing in
history parses, run create mode.

## 2. Compute the change set

```
git status --porcelain                  # uncommitted changes — include them, set dirty
git diff --shortstat <base> HEAD -- . ':!repo-wiki/' ':!*.lock' ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml' ':!*.generated.*'
git diff --name-status <base>..HEAD     # committed changes
```

- **Zero-change short-circuit**: if the working tree is clean and `--shortstat` reports
  no changed lines, stop here. Print "wiki is already up to date at `<short-commit>`"
  and write nothing at all — not `generatedAt`, not `meta.json`, not a re-copied
  `style.css`. A no-op run must leave the wiki byte-identical.
  - **Unless the base came from history and `repo-wiki/` is missing on disk.** Then
    restore it: copy `$TMP/repo-wiki/` to `repo-wiki/` verbatim, keeping the recorded
    `generatedAt` and hashes, and report that you restored rather than regenerated.
    The content is already correct for HEAD; only its absence needed fixing.
- **The wiki never counts as a change to itself.** Exclude `repo-wiki/` from both the
  diff and the dirty check — a committed wiki would otherwise make every subsequent run
  believe the repo changed, and a deleted-but-committed wiki folder shows as a pile of
  deletions that mean nothing about the source.
- Apply `settings.exclude` patterns and ignore vendored/lock/generated noise the same
  way recon does.
- If the tree is dirty but no *material* file changed (only lockfiles, generated
  output, excluded paths, or `repo-wiki/` itself), say so and stop the same way.

There is deliberately **no size-based full-rebuild trigger** here. A 12,000-line diff
confined to one package still maps cleanly to two pages; page-mapping decides, not
line count. The escalation rules in §5 are structural, and that is on purpose.

## 3. Map changes to pages

For each changed path, a page is **affected** when the path matches one of its
`meta.json` `sources` entries — exact file match, or prefix match for entries ending
in `/`. Additionally:

- **Renames** (`R` status): match both old and new paths.
- **Deletions**: a page whose sources are now all deleted is **orphaned** — remove it
  (and its nav/search/meta entries) or merge a residual mention into its parent
  section's most related page.
- **New code**: changed paths matching *no* page's sources → candidates for new pages
  or for widening an existing page's scope. A new top-level directory or package with
  substantial code (> ~500 LOC) gets a new page; smaller additions extend the closest
  existing page's sources.
- **Always-affected pages** regardless of mapping — they describe the commit snapshot
  itself, so any change invalidates them:
  - `index.html` — stats, commit stamp, card grid.
  - `by-the-numbers.html` — every number moved. Also strip any per-person commit table
    inherited from an older run; contributor *counts* stay, people don't.
  - `history.html` — new commits are new history. Usually this is an append (the latest
    era gains events, or a new era opens); rewrite the whole page from fresh `git log`
    output anyway, and only declare a *new* era when the evidence shows a real phase
    change, not merely because time passed.
  - `maintainers.html` when it exists — "last activity" and recent-contributor columns
    are stale the moment anyone commits. Recompute against the default branch, not the
    branch being updated from.
  - `fun-facts.html` when it exists — an "oldest TODO" or "longest file" can stop being
    true. Re-verify each fact; drop the ones that no longer hold rather than editing
    them into vagueness.
  - Per-page bylines on any page being rewritten, from the same recomputed map.
  - `review-guide.html` hotspots when churn since base is significant.
- `background.html` is *not* always-affected: rationale doesn't change because code did.
  Refresh it only when its cited ADRs/design docs changed, or a migration it describes
  finished.

## 4. Detect hand edits before overwriting

For every page about to be rewritten or removed, hash the current file and compare to
`meta.json` `hash`. Mismatch ⇒ a human edited it. Do not silently destroy their work:
preserve the page, regenerate your version alongside nothing — instead report the
conflict in the final summary and only overwrite if the user confirms (when running
non-interactively, skip the page, mark it `"handEdited": true` in `meta.json`, and say
so loudly in the report).

## 5. Escalate to full rebuild when incremental would mislead

Trigger a full rebuild (create mode pipeline, reusing recon knowledge) when any holds:

- > ~60% of pages are affected, or
- structural shifts: build system replaced, top-level layout reorganized, a package
  added/removed that changes the section plan, or
- `meta.json` carries a `repoWiki` marker this skill does not know (see §1.4 — `1`
  and `2` are both fine and upgrade in place; anything else rebuilds).

Announce the decision and the reason either way.

## 6. Re-research and rewrite

- Re-run targeted recon on the affected areas only (`git log <base>..HEAD -- <paths>`
  for intent, then read the changed files and their neighbors). Fan out parallel
  subagents per affected page when the runtime supports it — same research-brief
  format as create mode.
- Rewrite each affected page in full from fresh evidence (old page is reference, not
  truth). Update line-range citations — line numbers move even in untouched sections.
- Add planned new pages; delete orphaned page files.
- **New required pages on an older wiki.** A base wiki predating a page that is now
  required gets it added here: `history.html` for any git repo with a usable log,
  `maintainers.html` once the repo has ≥ 2 human contributors. Both come out of the
  shared page budget — if the wiki is already at its cap, merge or drop the weakest
  existing page and say which, rather than exceeding 30.

### Screenshots on update

Do not re-capture by default: launching dev servers on every refresh is expensive and
usually pointless. Re-run Phase 3.5 only when the user asked for it this run, or when
the source paths behind a captured surface actually changed (the app's routes,
components, or CLI command definitions are in the change set). Otherwise carry
`assets/media/*` and the `meta.json` `images` entries forward untouched.

When a page that holds a shot is rewritten, re-embed its existing figures in the new
prose — never drop an image silently because the page was regenerated. Delete a media
file (and its `images` entry) only when the surface it shows is gone, or when the
re-capture replaced it.

## 7. Refresh shared artifacts

Always, after page work:

1. `assets/nav.js` — page list/order/titles (and tagline if the project's pitch changed).
2. `assets/search-index.js` — regenerate entries for every added/rewritten page;
   drop removed ones.
3. `index.html` — stat strip, card grid (if pages changed), commit references.
4. `meta.json` — new `generatedAt`, `repo` block (commit/branch/defaultBranch/dirty),
   per-page `sources`, `contributors`, and `hash` for rewritten pages; remove deleted
   pages; carry `images` forward (or rebuild it if captures re-ran); keep `settings`;
   set `repoWiki` to `2` if the wiki now carries `images` or `contributors`.
5. `assets/style.css` + `assets/wiki.js` — re-copy from the skill if its copies differ
   (skill upgrades propagate this way). Never edit them in place. Pages kept from an
   older run keep their own inline `<head>` theme script; that only costs a brief
   flash on load, since `wiki.js` re-applies the right theme. Refresh those heads from
   `assets/page.template.html` only if you are rewriting the page anyway.

## 8. Verify and report

Run the same verification checklist + `scripts/validate.py` as create mode. Then
report concisely: commit range (`<base-short>..<head-short>`), where the base came from
(local `repo-wiki/` or a wiki recovered from commit `<c>`), pages updated / added /
removed (with one-line reasons), hand-edit conflicts skipped, screenshot decisions, and
anything the diff touched that the wiki deliberately does not cover.
