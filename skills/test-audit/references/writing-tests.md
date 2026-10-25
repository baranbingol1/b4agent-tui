# Writing and adding tests: boundary and cost

<!-- From openclaw/openclaw docs/help/testing/writing-tests.md at
     ecc3a77078f8 (MIT, Copyright (c) 2026 OpenClaw Foundation). Adapted for
     b4agent: kept the general sections; dropped OpenClaw's planner budgets,
     CI lanes, fixture recipes and file paths. -->

## Prove behavior at the owning boundary

Prove a caller-visible contract through its production owner, with fixed external I/O fixtures and independent expected values. Prefer focused integration tests and independent unit contracts over mocked internal decisions or whole-product boots. Name the credible regression, and what the test cannot prove.

Work in vertical slices: failing behavior, coherent repair, passing proof. A regression test must fail on the original defect, not on fixture setup; say so when you couldn't show the failing baseline. Refactor under green tests, and keep distinct contracts distinct when consolidating coverage. Use synthetic content and keep credentials out of captures.

Too many private controls suggest fragmented ownership, not a need for test-only exports.

## Cost

- Measure each new or changed test file on its own and report its wall time.
- A test that takes seconds must prove a contract no cheaper layer can. Long end-to-end compositions belong in a slower tier (release-only or nightly) where the project has one.
- Aim for a few seconds per file. Past about 30 seconds, explain the contract and why no cheaper layer proves it.
- Inject clocks; don't add real timers, sleeps or polling. Isolate each file's state. Reuse suite-level process or server fixtures instead of booting one per test. Import narrow modules, not broad barrels. Fix shared state rather than serializing tests or pinning workers.
- In async end-to-end tests, wait on the produced state, never on an action's return.

## Flakes

Reproduce the original order before running the test alone: an order-only failure usually means an earlier file leaked shared state. Classify the cause: fixture state, a missing completion signal, or a product race. Repair the producer. If a removal caused the failure, read why it was removed before restoring it. Choose repeat counts for the failure mode you reproduced, not a fixed clean-run quota.

## Adding regressions

For capacity bugs, pass bounded synthetic inventories and fixed timing through the real planner.

For bugs seen against a live provider or service, prefer a CI-safe regression at the smallest production composition that reaches the defect: real adapters with captured requests, integration through the real pipeline, or independent parser unit contracts. Keep inherently live-only checks narrow and opt-in.
