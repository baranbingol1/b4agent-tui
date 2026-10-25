# Upstream

- repo: https://github.com/NousResearch/hermes-agent
- path: `skills/productivity/pdf`
- commit: 6932521f258cca074ed206254b329d5b3b982eac (2026-10-21)
- license: MIT, Copyright (c) 2026 Nous Research (`LICENSE`)
- local changes: frontmatter, tool names and prerequisites as in the docx skill (`scripts/check_deps.py`); `references/nano-pdf-editing.md` dropped (needs an LLM API key); `references/ocr-extraction.md` rewritten as an opt-in path: pymupdf (AGPL-3.0) and marker-pdf (GPL-3.0) are installed only with the user's consent (`check_deps.py pdf --ocr --install`), Hermes' `web_extract`/`execute_code` removed. `extract_pymupdf.py` and `extract_marker.py` are unchanged and import those packages only when run.
