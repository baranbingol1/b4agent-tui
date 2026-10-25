# Upstream

- repo: https://github.com/NousResearch/hermes-agent
- path: `skills/productivity/xlsx`
- commit: 6932521f258cca074ed206254b329d5b3b982eac (2026-10-21)
- license: MIT, Copyright (c) 2026 Nous Research (`LICENSE`)
- also: `references/formulas-and-formatting.md` from openai/skills `skills/.curated/spreadsheet/SKILL.md` @ e6afb0d74cc75d220df2faf3dd6c635c2dc6a108 (the last commit before the skill's removal in fdf90d6), Apache-2.0 (`LICENSE-APACHE.txt`).
- local changes: frontmatter, tool names and prerequisites as in the docx skill (`scripts/check_deps.py`); `xlsx_recalc.py` gains a formula-error scan (`error_total`, `error_counts`, `errors`; `#REF!` in formula text wins over the cached error; `--strict` exits 2) and two tests for it in `tests/test_xlsx_skill.py`.
