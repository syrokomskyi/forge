---
name: fo-add-tests
description: Write unit and property-based tests for session-produced or specified code. Uses vitest + fast-check per RFC-XXXX.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggers: ["write tests for this code", "add unit tests", "add property-based tests", "write test coverage for this function"]
---

# fo-add-tests

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Write tests for code that was produced in the current session, or for a file/module the operator points at. The skill decides per-function whether to write example-based tests, property based tests (PBT), or both — following the RFC-XXXX decision tree and the TDD discipline absorbed from the former `tdd` skill.

## Tests are written for agents, not humans

The primary reader of test output is an **AI agent** looking at a console — not a human reading a test file. This changes how tests should be written:

### Agent-readable failure messages

When a test fails, the agent reading the console output needs to know **what to fix and where**. Vitest's default output shows the assertion, the expected value, and the received value. For simple assertions this is enough — `expect(result).toBe(42)` failing with `received 41` makes the fix obvious.

For **non-obvious failures** — complex invariants, multi-step pipelines, domain-specific rules — add a failure message that tells the agent what went wrong and where to look:

```ts
// Good: obvious failure — no message needed
expect(normalized).toBe("hello world");

// Good: non-obvious failure — message guides the agent
expect(
  result.deduplicatedCount,
  "Pipeline must skip already-validated entries. If count > 0, check the dedup guard in validateEntry() — entries with a matching hash in the seen-set should be skipped, not re-processed.",
).toBe(0);

// Good: invariant failure — message explains the contract
expect(
  manifest.entries.length,
  "Every published Nachweis must produce exactly one manifest entry. Missing entries indicate nachweis-publish.ts skipped a record — check the bordbuch filter.",
).toBe(publishedCount);
```

### When to add a message

- **Obvious from the assertion** (simple equality, type check, presence check) → no message needed. The assertion itself is the documentation.
- **Non-obvious invariant** (multi-step pipeline, domain rule, cross-module contract) → add a message explaining what the invariant is and where to look if it fails.
- **PBT property** → the comment above the property already explains the algebraic property. No additional failure message needed unless the property name is unclear.

### What makes a good failure message

A good failure message answers two questions for the agent:

1. **What is the invariant?** — state the contract in plain language.
2. **Where to look** — name the function, file, or logic branch that is likely wrong.

Bad: `"test failed"` — tells the agent nothing. Bad: `"count should be zero"` — restates the assertion, adds no information. Good: `"Pipeline must skip already-validated entries — check the dedup guard in validateEntry()"` — states the invariant and points to the likely fix location.

### Test naming

Test names are specifications — they describe behavior, not implementation. An agent scanning test names should understand what the system does without reading the test body.

```ts
// Bad — describes implementation
test("calls validateEntry with correct args", () => { ... });

// Good — describes behavior
test("pipeline skips entries that were already validated in a previous run", () => { ... });
```

## Preconditions

- The code to test must exist in the workspace — either produced earlier in this session, or at a path the operator provides.
- The target package must have `vitest` configured. If it does not, set it up first (see "Package setup" below).

## Process

### 1. Identify the code to test

Determine the target in this order:

1. **Operator argument** — a file path, package name, or function name.
2. **Session context** — files created or modified earlier in this session (check git diff or the session's edit history).
3. **Ask** — if neither yields a target, ask the operator what to test.

### 2. Read the code and classify each function

For each exported function in the target file(s), classify it using the RFC-XXXX decision tree (see `pbt-guide.md` for the full tree and property patterns catalog):

```
Is the function pure (no I/O, no side effects, no mutation of inputs)?
├── No → Example-based tests or integration tests. Do NOT use PBT.
└── Yes → Does the function have at least one verifiable algebraic property?
    ├── No → Example-based tests. Do NOT use PBT.
    └── Yes → Is the input domain large enough that examples are insufficient?
        ├── No (small enum, <10 values) → Example-based tests with exhaustive coverage.
        └── Yes → Write PBT in a *.pbt.test.ts file using fast-check.
```

Record the classification for each function. Present a brief summary to the operator before writing tests. Report in `aiLanguage`.

### 3. Determine the test seam

Tests verify behavior through **public interfaces**, not implementation details. The seam is:

- **For exported functions** — call the function directly, assert on its return value or observable side effects.
- **For modules** — call through the module's public API, not its internals.
- **For integration** — call through the command handler or CLI entry point.

See `tests-reference.md` for good and bad test examples — the anti-patterns (tautological, implementation-coupled, horizontal slicing) are load-bearing.

### 4. Write the tests

#### Example-based tests (`*.test.ts`)

- Import from `vitest`: `import { test, expect } from "vitest"`.
- Do NOT import from `node:test` or `node:assert/strict` (RFC-XXXX, forward-only).
- One test per behavior, named as a specification: `"user can checkout with valid cart"`.
- Expected values are independent known literals — never recompute the expected value the same way the code computes it.
- Place in `src/tests/**/*.test.ts` (or `src/**/tests/**/*.test.ts` for nested source).

#### Property-based tests (`*.pbt.test.ts`)

- Import from `vitest` and `fast-check`: `import { test, expect } from "vitest"; import fc from "fast-check"`.
- Use `fc.assert(fc.property(arb, fn))` or `fc.assert(fc.asyncProperty(arb, fn))`.
- PBT tests are **additive** — never replace existing example-based tests with PBT.
- Write a comment above each property stating which algebraic property it verifies and why it holds.
- Place in `src/tests/**/*.pbt.test.ts` alongside existing tests.
- See `pbt-guide.md` for the full property patterns catalog and worked examples.

#### Mocking

Mock at **system boundaries** only — external APIs, databases, time, randomness. Do NOT mock your own modules or internal collaborators. See `mocking.md` for the full rules.

### 5. Run the tests

For the target package:

> Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```sh
rtk pnpm --filter <package-name> test
```

If the tests fail (red):

1. Read the failure output.
2. Determine whether the test is wrong (bad assertion, wrong seam) or the code is wrong (bug).
3. Fix the test or report the bug to the operator — do NOT silence a failing test by weakening it.

If the tests pass (green), proceed.

### 6. Commit

Stage only the test files and any test infrastructure changes (e.g. `vitest.config.ts`, `package.json` devDependencies).

```text
test(scope): add unit and PBT coverage for <module>
```

Do not stage unrelated changes. See `_shared/fo-pipeline-conventions.md` §Commit discipline.

### 7. Check whether AGENTS / README updates are needed

This step is **always performed** — it is not optional and must not be skipped.

Analyze whether the new tests introduced patterns, conventions, or infrastructure that other agents should know about:

- Did you add `fast-check` to a package that didn't have it? Update the package's README or AGENTS.md.
- Did you create a new `vitest.config.ts`? Document it.
- Did you establish a new test seam or pattern worth documenting?

If no updates are needed, state this explicitly.

## Package setup (if needed)

If the target package does not yet have `vitest` configured:

1. Add `vitest` and `fast-check` to `devDependencies` in `package.json`.
2. Set `"test": "vitest run"` and `"test:watch": "vitest"` in scripts.
3. Create `vitest.config.ts` at the package root:

   ```ts
   import { defineConfig } from "vitest/config";

   export default defineConfig({
     test: {
       environment: "node",
       include: ["src/tests/**/*.test.ts", "src/**/tests/**/*.test.ts"],
     },
   });
   ```

4. Run `pnpm install` to update the lockfile.
5. Do NOT add `node:test` shims or legacy assertion wrappers — the migration is forward-only.

## TDD mode

When invoked as `/fo-add-tests --tdd` or when the operator says "test-first" / "red-green":

1. Write the test **before** the implementation.
2. Watch it fail (red).
3. Write the minimum implementation to pass.
4. Watch it pass (green).
5. Refactor.

This is the red → green loop. Each cycle produces one test worth keeping — a test that reads like a specification and survives refactors because it doesn't care about internal structure.

## Constraints

- **Per-function classification.** The PBT-vs-example decision is made per-function, not per-file. A single file may have both `*.test.ts` and `*.pbt.test.ts` tests.
- **PBT is additive.** Never replace existing example-based tests with PBT. PBT complements, not replaces.
- **No `node:test`.** All tests use `vitest` imports. No `node:test` or `node:assert/strict` (RFC-XXXX, forward-only).
- **No `as any` to silence type errors.** Fix the type or use proper test utilities.
- **Do not weaken or delete existing tests** without explicit operator direction.
- **Test through public interfaces.** Tests that couple to implementation details break on refactors and give false confidence.
- **Deterministic PBT.** If the property involves randomness, the random source must be the fast-check generator, not `Math.random()` or `Date.now()`.
- **Comment every property.** State which algebraic property it verifies and why it holds.
- **Scoped verification only.** Run `pnpm --filter <package> test` — do NOT run root `build` or `turbo run build`. See `_shared/fo-pipeline-conventions.md` §Build verification discipline.
- **Commit only your own files.** Stage only test files and test infrastructure. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
