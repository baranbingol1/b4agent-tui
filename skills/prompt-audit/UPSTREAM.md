# Upstream

- repo: https://github.com/anthropics/skills
- path: `skills/claude-api/shared/prompt-audit.md` (last changed in 9d630808e4ad)
- commit: dbd4588f9e1033efb41dad4bef2f7947c8993d44 (2026-10-09)
- license: Apache-2.0, Copyright 2026 Anthropic, PBC (`LICENSE.txt`, from `skills/claude-api/`)
- local changes: extracted as its own skill (the rest of the claude-api skill isn't vendored). Provider-neutral: Claude model names, per-model API claims and links to `shared/model-migration.md` / `prompt-caching.md` replaced by "check the provider's documentation for the target model". Inventory adds `AGENTS.override.md`, Pi's `.pi/` (`SYSTEM.md`, `APPEND_SYSTEM.md`, `skills/`, `prompts/`, `agents/`), `.agents/skills/`, b4agent's subagent roster and `b4agent.json`; Pi's context-file precedence noted. Keep-list item 12 (license comments) added.
