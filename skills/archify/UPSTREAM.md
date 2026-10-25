# Upstream

- repo: https://github.com/tt-a1i/archify
- path: `archify/`
- commit: 25cf37080fc8b1dbe758a4efc3935b55f3327083 (2026-10-19, v3.2.0-9-g25cf3708; skill version 3.2). Copied from that commit's `archify/` tree with `git archive`; previously pinned at 29f1ff53814b (v2.17.0-dev.1). Pull later changes deliberately with `scripts/vendor-diff.mjs archify`.
- license: MIT, Copyright (c) 2026 tt-a1i (Archify) and (c) 2025 Cocoon AI (`LICENSE`). Brand marks, the JetBrains Mono font and the Pele subset (MIT, kepano, `explainer/vendor/pele/LICENSE`): see `THIRD_PARTY_NOTICES.md`.
- local changes (b4agent pins and diffs instead of checking for updates):
  - `SKILL.md`: removed the "Update awareness" section and its two cross-references (the `finalize` handoff note and the "Keep the required update notice" sentence under Output).
  - `bin/delivery-update.mjs`: `startDeliveryUpdateCheck` always returns `unavailable` with reason `disabled` (a `BUNDLED_PIN` constant), so `finalize` and `deliver` never fetch the remote update manifest. Upstream did that only with `ARCHIFY_UPDATE_CHECK_DISABLED=1`.
  - `scripts/check-update.mjs`, `scripts/delivery-update-child.mjs` and `references/update-awareness.md` are still shipped but no longer reached.

Local change (2026-10-25): the frontmatter description is shortened to keep the always-loaded skills list small.
