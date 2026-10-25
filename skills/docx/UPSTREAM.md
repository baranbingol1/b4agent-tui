# Upstream

- repo: https://github.com/NousResearch/hermes-agent
- path: `skills/productivity/docx`
- commit: 6932521f258cca074ed206254b329d5b3b982eac (2026-10-21)
- license: MIT, Copyright (c) 2026 Nous Research (`LICENSE`)
- also: `scripts/render_docx.py` and the "Rendering pages for review" section from openai/skills `skills/.curated/doc/` @ 45d05d75363abf13f99d09e899d61e07b8010685 (the last commit before the skill's removal in 228962a), Apache-2.0 (`LICENSE-APACHE.txt`).
- local changes: frontmatter in Pi's format, longer description; Hermes tool names (`terminal`, `write_file`, `read_file`, `vision_analyze`) mapped to Pi's (`bash`, `write`, `read`); `scripts/check_deps.py` (b4agent, shared by the four office skills) and the prerequisites rewritten around it; the render loop; the comment author default `Hermes` → `b4agent`; `render_docx.py` imports pdf2image lazily.
