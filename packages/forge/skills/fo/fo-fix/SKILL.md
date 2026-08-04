---
name: fo-fix
description: Iterative fix workflow for AI-generated work. Calls fo-review if needed, applies findings, runs scoped typecheck, commits, and delegates doc updates to fo-doc-audit.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.typecheck]
  optional: [commands.test, paths.invariantsFile]
triggers: ["fix issues from review", "apply review findings and fix", "iterative fix workflow for code"]
---

# fo-fix

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Turn a review into corrected code and a green build, then commit. Run in the session where the AI-generated work already lives.

This skill also handles two related fix scenarios:

- **Bug diagnosis** — when the operator reports a bug, regression, or performance issue that requires systematic diagnosis before fixing. See `bug-diagnosis.md` for the 6-phase diagnosis loop (build feedback loop → reproduce → hypothesise → instrument → fix + regression test → cleanup + post-mortem).
- **Merge conflict resolution** — when an in-progress git merge or rebase has conflicts. See "Merge conflict resolution" below.

## Preconditions

- The artifact (code, docs, etc.) must be present in the current session or workspace.
- There must be enough context to apply fixes without guessing.
- For bug diagnosis: the operator has reported a specific symptom (broken, throwing, failing, slow).

## Process

### 0. Pre-flight: git status check

Before starting the fix workflow, check the working tree for foreign uncommitted changes:

1. Run `git status --short` in the werkstatt root.
2. If `systems/registry.yaml` has a `currentMission`, also run `git status --short` in each active mission workpiece directory (`missions/<missionId>/workpiece/`).
3. If either repository has changes, report them to the operator before proceeding.
4. Treat all pre-existing changes as foreign — never modify, stage, or discard them.
5. When committing, stage only files you created or modified in this session by explicit path. Never use `git add -A` or `git add .`.
6. Before every commit, verify `git diff --cached --name-only` excludes foreign files.

### 1. Check for an existing review

Scan the current session for evidence of a review:

- A persisted review report in `docs/reviews/code/**/*.md` (written by `/fo-review`).
- A previous `/fo-review` invocation or its output in the current session — look for axis sections like `### Axis A — Structural correctness`, `### Axis B — DNA alignment`, etc.
- Markdown sections like `[Critical errors]`, `[Warnings / architectural notes]`, or `[Concrete refactor]` (legacy format, still supported).
- A user statement such as "fix the issues from the review".

If no review is found, run `/fo-review` (or execute its process inline) on the artifact, wait for the review output, and use that as the fix list.

### 2. Apply fixes

Use the review findings as the fix list. The verdict is **not** a stop signal — even an `Approved` review (legacy or lax criteria) may contain findings that must be fixed. Read every axis section and process every finding, regardless of what the verdict line says.

Process findings by axis severity:

1. **Verdict Rejected** — the change has a fundamental flaw (DNA violation, backward compatibility layer, storage policy bypass). Fix all failures before anything else.
2. **Axis B / D / E failures** — DNA alignment, forward-only compliance, and agent-facing clarity are hard failures. Fix these next. Do not skip without explicit user approval.
3. **Axis A / C / F / G findings** — structural correctness, ecosystem fit, pragmatism, and blind spots. Fix **all** findings, including cosmetic ones. Do not skip or downgrade a finding because it is "minor" or "cosmetic" — if the reviewer flagged it, it gets fixed.
4. **Spec compliance gaps** — missing or partial requirements from the original spec. Fix in order of importance.

**No discretionary skipping.** Every finding in the review report must be addressed with a code change. If a finding is truly a false positive, the agent MUST explain why in the session output and get explicit user approval before skipping — but the default is to fix, not to skip.

If the review used the legacy format (`[Critical errors]`, `[Warnings]`, `[Concrete refactor]`), map: Critical → priority 1, Warnings → priority 2, Refactor → priority 3.

For each finding:

- If it includes a concrete line range or code snippet, apply the change directly.
- If it is ambiguous, ask the user before changing.
- Do not delete or weaken existing tests without explicit direction.
- Prefer minimal upstream fixes over downstream workarounds.

After applying fixes, update any tests that should cover the change, then run the relevant package tests before the full build when that saves time.

### 3. Run scoped typecheck verification

**MUST NOT run root `root build` or `turbo run build`.** These commands build every workspace in the monorepo and are prohibitively expensive for iterative fix workflows. See root AGENTS.md §Build verification discipline.

Before running verification, classify the changes made in step 2:

- **Code changes** — any modification to executable source: `.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`, `.astro`, `.json`, `.jsonc`, `.yaml`, `.yml`, `.css`, `.scss`, `.html`, `.vue`, `.svelte`, `.py`, `.go`, `.rs`, or any file that is imported/resolved at build time.
- **Comment-only changes** — changes inside `// ...`, `/* ... */`, `<!-- ... -->`, or `# ...` without any change to the surrounding executable code.
- **Documentation-only changes** — changes confined to `.md` files (including `AGENTS.md`, `README.md`, RFC files, ADR files, `docs/**`) that are not imported as code or rendered by the build.

If **all** changes are comment-only or documentation-only (no code changes whatsoever), **skip verification** and note in the session output:

> "Сборка пропущена: изменения затрагивают только комментарии или документацию, исполняемый код не изменён."

Otherwise, determine which workspaces were touched by the fixes in step 2 and run scoped typecheck verification for each:

- **For each touched `apps/*` workspace:**

  > Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```sh
  pnpm --filter <app-name> exec astro check
  ```

- **For each touched `packages/*` workspace:**

  ```sh
  pnpm --filter <package-name> run build:check
  ```

  (For packages, `build:check` is `tsc --noEmit` — a lightweight typecheck, not a full build.)

If a workspace cannot be determined from the diff, ask the operator which workspace to verify.

All scoped checks must pass. If any fails:

- Read the error output and identify the root cause.
- Fix the cause, not the symptom.
- Re-run the failing check.
- Repeat until all scoped checks pass.

### 4. Commit the fixes

Stage and commit the changes with a descriptive message.

```text
rtk git add ...
rtk git commit -m "fix(scope): ..."
```

Do not commit secrets, API keys, or unrelated changes.

### 5. Compass header update (fo-compass-annotate)

If the fix touched any source files (`.ts`, `.astro`, `.js`, `.mjs`, `.css`), invoke the `fo-compass-annotate` skill via the `skill` tool with `--changed` flag to update Compass headers (MODULE_CONTRACT, CHANGE_SUMMARY) on changed files. Wait for it to complete.

If no source files were touched, skip this step.

### 6. Documentation audit (fo-doc-audit)

This step is **always** performed — it is not optional and must not be skipped.

Invoke `fo-doc-audit` via the `skill` tool. It analyzes the session's changes, checks all documentation surfaces (AGENTS.md, README, Compass XML, `ref(forge.yaml bindings.paths.invariantsFile)`, templates, generated artifacts, COMMANDS.md/PACKAGE_GRAPH.md), applies needed updates, and commits them separately. Wait for it to complete.

If `fo-doc-audit` reports that no updates are needed, state this explicitly and move on — the check itself is the mandatory part, not the outcome.

## Merge conflict resolution

When invoked to resolve an in-progress git merge or rebase conflict:

1. **See the current state** of the merge/rebase. Check git history and the conflicting files.
2. **Find the primary sources** for each conflict. Understand why each change was made and what the original intent was. Read commit messages, check PRs, check original issues/tickets.
3. **Resolve each hunk.** Preserve both intents where possible. Where incompatible, pick the one matching the merge's stated goal and note the trade-off. Do **not** invent new behaviour. Always resolve; never `--abort`.
4. **Documentation audit.** Invoke `fo-doc-audit` via the `skill` tool. It analyzes the merge changes, checks all documentation surfaces, applies needed updates, and commits them. If no updates are needed, it states this explicitly.
5. **Run automated checks.** Discover the project's automated checks and run them — typically typecheck, then tests, then format. Fix anything the merge broke. Follow the scoped verification rules in step 3 above.
6. **Finish the merge/rebase.** Stage everything and commit. If rebasing, continue the rebase process until all commits are rebased.

## Completion criteria

- The review findings were all addressed with code changes. No finding was skipped without explicit user approval for each individual skip.
- Root `root build` / `turbo run build` was **not** run.
- Scoped typecheck verification (`astro check` for touched apps, `tsc --noEmit` for touched packages) passes for every touched workspace, **or** verification was skipped because all changes were comment-only or documentation-only.
- At least one fix commit exists on the branch.
- `fo-doc-audit` was invoked and documentation surfaces were checked; any doc changes are committed separately.
- For bug diagnosis: the 6-phase loop in `bug-diagnosis.md` was followed, or phases skipped were explicitly justified.
- For merge conflicts: all hunks resolved, automated checks pass, merge/rebase completed.
