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
