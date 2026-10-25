# Upstream

- repo: https://github.com/openai/codex
- path: `codex-rs/skills/src/assets/samples/skill-creator`
- commit: c419fd01a70dd1d05356da443ac44328bda2e6f4 (2026-10-21)
- license: Apache-2.0, Copyright 2025 OpenAI (`LICENSE.txt`, upstream `license.txt`)
- local changes: b4agent/Pi skill locations and frontmatter rules; `agents/openai.yaml`, `generate_openai_yaml.py`, `references/openai_yaml.md` and the icons dropped (Pi's `disable-model-invocation` replaces the invocation policy); forward-testing through b4agent's `agent` tool. `init_skill.py` no longer writes openai.yaml; `quick_validate.py` accepts Pi's extra keys and checks the name matches the folder.
- also: `references/evals.md` is new text after the eval method in anthropics/skills `skills/skill-creator/SKILL.md` @ dbd4588f9e1033efb41dad4bef2f7947c8993d44 (Apache-2.0, Copyright 2026 Anthropic, PBC). None of Anthropic's scripts, viewer or grader prompts are included.
