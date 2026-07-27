---
name: fo-compass-annotate
description: Full-lifecycle Compass header management — generate, update, audit, validate, cleanup. Replaces removed compass.annotate/clear/migrate/invariant.add commands.
invocation: user
category: fo
concerns: content-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [compass.fileExtensions, compass.testPatterns]
triggers: ["manage Compass headers", "annotate source files with Compass", "audit Compass module contracts"]
---

# fo-compass-annotate

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Manage Compass source headers across files with a full lifecycle: discover, generate, update, audit, risk-flag, validate, and cleanup. This skill replaces the removed `compass.annotate`, `compass.clear`, `compass.markup.migrate`, and `compass.invariant.add` kernel commands.

## Preconditions

- The workspace has source files with Compass scaffolding requirements (DNA-42).
- `compass.validate` is available to verify headers after updates.

## Flags

- `--file <path>` — process a single file instead of scanning the workspace.
- `--changed` — process only files changed in the current git diff (unstaged + staged).
- `--packages` — scan `packages/` instead of the default workspace scope.
- `--package <name>` — with `--packages`, scan one package.
- `--dry-run` — report what would change without writing files.

## Process

### 1. Discover files

Determine the scan scope:

- If `--file` is given, process only that file.
- If `--changed` is given, run `git diff --name-only HEAD` (or `git diff --name-only --cached` + `git diff --name-only`) to get the changed file list. Filter to source files matching `ref(forge.yaml bindings.compass.fileExtensions)` (default: `.ts`, `.astro`).
- Otherwise, scan the workspace (or `packages/` with `--packages`) for all source files matching the file extension binding.

Skip files that are:

- Generated (carry `GENERATED` marker or are in `dist/`, `node_modules/`, `.agents/`).
- In `spec/`, `todo/`, or folders starting with `old-` or `-`.
- Binary or non-text.

### 2. Per-file processing

For each discovered file, determine the required action:

#### 2a. Generate (file has no Compass headers)

If the file has no `MODULE_CONTRACT` and no `CHANGE_SUMMARY` block:

1. Read the file content and understand its purpose.
2. Use `templates/header-prompt.md` to generate a `MODULE_CONTRACT` block with `<purpose>` and `<non-goals>`.
3. Create a `CHANGE_SUMMARY` block with a single `<item>` noting the initial creation.
4. Insert both blocks at the top of the file, after any existing license/comment header but before imports.
5. Use `reference/comment-styles.md` to determine the correct comment syntax for the file extension.

#### 2b. Update (file has headers but content has changed)

If the file has Compass headers but the content has significantly changed:

1. Read the current `MODULE_CONTRACT` and compare with the file's actual purpose.
2. Use `templates/header-prompt.md` to regenerate the `MODULE_CONTRACT` if the purpose has shifted.
3. Add a new `<item>` to `CHANGE_SUMMARY` referencing the current RFC or change.
4. Run `compass.summary.trim` if the `CHANGE_SUMMARY` exceeds 30 total items.

#### 2c. Audit (semantic check)

For each file with Compass headers:

1. Use `templates/audit-prompt.md` to audit the `MODULE_CONTRACT` against the file's actual content.
2. Check that `<purpose>` accurately describes what the file does.
3. Check that `<non-goals>` lists at least one boundary the file does not cross.
4. Flag files where the header is stale, misleading, or empty.

#### 2d. Risk flag

For each file with Compass headers:

1. Use `reference/risk-patterns.md` to scan for deterministic risk patterns (sign, crypto, vault, migrate, publish, etc.).
2. If a risk pattern is found, add a `<!-- risk: <pattern> -->` comment inside the `MODULE_CONTRACT` block.
3. Risk patterns are deterministic — no LLM judgment needed.

### 3. Batch-end validation

After processing all files:

1. Run `compass.validate` to verify all headers are well-formed.
2. If any violations are found, attempt to fix them automatically (missing `<non-goals>`, empty `<purpose>`, etc.).
3. Re-run `compass.validate` to confirm fixes.
4. If violations persist after 3 retry attempts, report them to the operator.

### 4. Cleanup (optional, with `--cleanup` flag)

If `--cleanup` is given:

1. Remove `TODO(compass)` sentinels from files that still have them.
2. Replace each sentinel with a real value generated using `templates/header-prompt.md`.
3. Run `compass.validate` to confirm no sentinels remain.

### 5. Report

Output a summary:

```
## Compass Annotate Report

### Files scanned: <N>
### Files generated: <N>
### Files updated: <N>
### Files audited: <N>
### Files risk-flagged: <N>
### Validation: <pass | fail>
### Sentinels replaced: <N>
```

## Completion criteria

- All discovered files have `MODULE_CONTRACT` and `CHANGE_SUMMARY` blocks.
- `compass.validate` passes with zero errors.
- No `TODO(compass)` sentinels remain (if `--cleanup` was used).
- All changes are committed with message `compass: update headers for changed files`.
