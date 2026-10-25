# Test-pruning campaign

<!-- From openclaw/openclaw .agents/skills/test-audit/CAMPAIGN.md at
     ecc3a77078f8 (MIT, Copyright (c) 2026 OpenClaw Foundation). Adapted for
     b4agent: lanes and reviews run as b4agent subagents; OpenClaw's CI
     routing and line-cap tooling made generic. The Telegram examples are
     from OpenClaw's own campaign. -->

Campaign mode prunes one subsystem's whole test surface in one change: a plugin or package, or one core area. The value bar, retention bar, candidate evidence and validation in [SKILL.md](SKILL.md) apply to every lane. This file adds the order of work and the lessons of a full campaign. Each step ends on its completion criterion; do not start the next step early.

Tell the user the plan and roughly how many subagents it will start before step 3; a campaign is long and costs real tokens.

## 1. Baseline

Record the subsystem's test and support line counts, and every test file's pass/fail state, at a pinned commit. Keep baseline failures in their own list: in OpenClaw's Telegram campaign, all three were real delivery bugs, not stale tests.

Done when every in-scope test file has a recorded baseline result.

## 2. Lanes and inventory

Split the surface into **lanes** along production owner boundaries, not file prefixes. For Telegram these were accounts, commands, context, dispatch, inbound, outbound, persistence, transport, shared, harness, and live/QA scenarios. Include the subsystem's cases at shared core boundaries and its QA and live-proof harness tests.

Done when every test file and QA scenario the subsystem owns belongs to exactly one lane.

## 3. Read-only ledger per lane

Give each lane to its own subagent: the `agent` tool with type `general`, all lanes started in the same turn so they run in parallel. Fresh agents see only the brief, so give each one its lane's files, the subsystem's `AGENTS.md`, the mark definitions below and the evidence rules from [references/audit.md](references/audit.md#candidate-evidence), and say plainly that it is read-only: it may read, search and run `git log`/`git blame` and the lane's tests, never edit, and it returns the ledger as its final report. (If campaigns recur, a read-only type made with the `create-subagent` skill, with `tools: read, bash, grep, find, ls`, saves repeating that.)

The agent reads every assigned test in full, including parameter tables. It also reads the production owners and their entry points, callers, history, and CI wiring. Each test declaration goes into the **ledger** with one mark. A table-driven test (`it.each`, `@pytest.mark.parametrize`) is one declaration unless its rows need different marks; then mark each row.

- `R`: retain, naming the contract and the bug it catches; a retained test that only moves to a better-named file stays `R` with the move noted;
- `F`: retain the contract but repair the assertion, such as a vacuous negative that passes when only one of several items is missing;
- `C`: consolidate, naming the owner that absorbs the assertion first: a sibling table case, a stronger boundary suite, or the shared owner in another package;
- `D`: delete, naming the proof that remains, or why no contract exists.

Judge a test by its assertions, not its name. One Telegram test named for retiring a progress window asserted the window was _not_ cleared.

Done when every declaration in the lane has a mark and an evidence line. Save the ledgers to files outside the repository (for example `/tmp/<subsystem>-campaign/`) so later steps can reread them.

## 4. Layer plan per lane

Treat the per-test ledger as input, not as the edit list. A second read-only pass per lane (another `general` subagent with the same read-only brief, given the ledger) looks for the redundant **layer**. In Telegram, several dispatch suites replayed the same shared compositor through one mocked preview, around stronger real-stream and HTTP-fixture suites. Name the **keeper** suite for each contract. Prefer the real transport boundary with a fake network over a mocked collaborator. Correct any ledger errors this pass finds.

Done when each lane plan names its retired files, its keeper per contract, the assertions to carry into keepers, and the test-only production seams unlocked.

## 5. Cutover

Edit lane by lane. Lanes that touch disjoint files can run as parallel writing subagents; give each lane a disjoint file set, or `isolation: "worktree"` when they can't be split. Serialize changes to shared harnesses and support files through one owner (you, or one agent). With each lane, remove the test-only production seams it unlocks: injection parameters, getters, reset exports, and indirection layers. Register moved suites wherever the project lists tests (CI configuration, test inventories). Update any shrink-only line-count baselines. Put durable test-ownership rules in the subsystem's `AGENTS.md`, drawn from mistakes this campaign actually found.

Done when every lane plan is applied and each lane's keepers pass.

## 6. Preservation review

Before claiming completion, have independent reviewers compare deleted coverage against the keepers, one reviewer per boundary group: fresh read-only `general` subagents given the lane plan, the diff, and the question below, not your conclusions. They look for contracts that lost their only proof. They also look for new assertions that cannot fail, such as a rejection row the production code never reaches. The Telegram review found nine real gaps and one unreachable assertion.

For each restored contract, make one deliberate **mutation** of the production owner and confirm the keeper goes red. Then restore the source byte for byte (`git diff` on the file shows nothing).

Done when every reported gap is restored or rejected with source evidence, and every restored contract has a caught mutation.

## 7. Product defects

A baseline failure that survives into a keeper is a bug report. Fix it at its owner as a separate commit, and prove it through the real user flow, with a **control** run that reverts the fix and shows the old behavior. Record unrelated product discrepancies you find as follow-ups instead of fixing them in the campaign.

Done when each repaired defect has a failing control and a passing candidate on the same harness.

## 8. Reconcile and hand off

Campaigns outlive many commits on the main branch. Merge it rather than rebasing a long, many-commit campaign. When the main branch modified a file the campaign deleted, keep the deletion. Port the new contract into the keeper instead, and confirm every new regression the main branch added still has a home. Rerun locally only the tests touched by the merge or failed in CI; let CI run the broad suites; repeat live proof when merged inputs affect a live contract.

Expect review tooling to show a truncated file list on a diff this large.

Hand off with the [SKILL.md](SKILL.md) report, plus:

- baseline and final test/support line counts, with production counted separately;
- lanes, retired layers, and keepers;
- preservation gaps found and their mutations;
- product defects with control and candidate proof.
