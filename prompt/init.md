Write the AGENTS.md for this project at `{{path}}`. {{state}}

AGENTS.md is read by coding agents (you, subagents, other harnesses) at the start of every session in this repository. It should hold what an agent would get wrong or waste time on without it, and nothing else. Test each line: would an agent working here likely miss this? If not, leave it out.
{{focus}}
## 1. Explore first

Read before you write, highest value first, and use subagents for a large repository:
- README, root manifests and workspace config (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, justfile...), lockfiles;
- build, test, lint, format, typecheck and codegen config, CI workflows, pre-commit hooks, scripts folders;
- other agents' instruction files: `CLAUDE.md`, `AGENTS.md` in subfolders, `.cursor/rules/`, `.cursorrules`, `.windsurfrules`, `.clinerules`, `.github/copilot-instructions.md`. Carry over what still holds;
- a few files that show how the code is wired (entry points, the main module boundaries), not random leaf files;
- `git log --oneline -30` for commit message conventions.

Trust what runs over what is written: when the docs and the scripts disagree, go with the scripts. Run a cheap check if it settles a doubt (the test command's `--help`, a dry run), but don't run long builds or anything that changes state.

## 2. Ask only what the repo can't answer

When you have explored, use `ask_user` once, with at most 3 questions, and only for decisions the repository can't settle and that change what the file says: an unwritten team convention, which of two conflicting commands is current, a branch or release rule, a setup step that isn't written down. Never ask about anything you could read or run. If nothing is unclear, don't ask.

## 3. Write

Keep it short: typically 20 to 60 lines of bullets under a few `##` headings, fewer for a small project. Cover, as they apply:
- **Commands:** the exact commands to build, test, lint, typecheck and run, and how to run one test or one package. Note the required order when it matters.
- **Layout:** where things live and what each main part owns, only where the names don't make it obvious. Not a file tree.
- **Conventions:** the ones that differ from the language's or framework's defaults, and how commits and PRs are written here.
- **Gotchas:** generated files not to edit, required services or env vars, slow or flaky suites, things that look safe and aren't.

Leave out: anything the README already says (link to it instead), generic advice ("write clean code", "add tests"), obvious language conventions, long explanations, and anything you didn't verify.

{{update}}

When done, reply with what the file covers in two or three lines, and any assumption you made.
