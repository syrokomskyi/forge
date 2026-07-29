---
name: fo-review
description: Cross-session fitness check of a code diff against Forge standards — DNA, forward-only, Compass, agent clarity, pragmatism. The code analogue of fo-idea-audit. Use when another agent produced code.
invocation: user
category: fo
concerns: read-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile, paths.compassDocs]
triggers: ["review this code diff", "check code against Forge standards", "fitness check on code changes"]
---

# fo-review

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

A read-only fitness check of a code diff against the Forge ecosystem's actual standards — DNA invariants, AGENTS.md rules, RFC contracts, and forward-only discipline. The review finds what linters and type checkers cannot: architectural drift, DNA violations, ecosystem misfit, and agent-facing clarity gaps.

The review does **not** modify any file. It produces a structured report, persists it to `docs/reviews/code/`, and stops. To apply fixes, run `/fo-fix` — it reads the persisted review and applies the findings.

## Scope

This skill reviews **code** — `.ts`, `.js`, `.tsx`, `.astro`, `.css`, `.json`, `.yaml`, `.mjs`, `.cjs`, `.py`, and similar source files.

- For **RFCs, ADRs, architecture docs, or plans**, use `/fo-idea-audit` instead.
- For **iterative fix-then-build-then-commit**, use `/fo-fix`.

## Process

### 1. Identify the diff

The scope of the review must be determined **explicitly** before any other action. The skill searches for review scope in this order:

1. **Prompt** — the user's invocation arguments (git fixed point, file paths, or pasted code).
2. **Session context** — files open in the IDE, uncommitted changes, or prior conversation context that clearly indicates what to review.
3. **Stop** — if no scope is found in either the prompt or the session, stop immediately and ask the operator: "What specifically should I review? Provide a git fixed point (commit, branch, tag), file paths, or paste the code."

The user may provide:

- **A git fixed point** — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. Capture `git diff <fixed-point>...HEAD` (three-dot, against merge-base). Also note commits via `git log <fixed-point>..HEAD --oneline`.
- **File paths** — one or more paths to review. Read each file directly.
- **Pasted code** — use it directly.

If a fixed point is given, verify it resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff fails here — not inside the semantic axes.

### 2. Run the mechanical floor

Run the mechanical floor first — it catches type errors, lint violations, and structural issues that don't need semantic judgment.

For a single affected package:

```sh
pnpm --filter <package-name> build:check
```

For an affected app:

```sh
pnpm --filter <app-name> exec astro check
```

For cross-workspace changes, run the affected workspaces' checks individually rather than a full root build.

If the diff touches RFC files, also run:

```sh
ref(forge.yaml bindings.commands.validateRfc) --json
```

Record any failures. The semantic review starts from the mechanical baseline; if the floor already fails, report it and still continue with the semantic axes — the human needs the full picture.

### 3. Load ecosystem context

Read the context the diff claims to fit into:

- `AGENTS.md` (root) — monorepo layout, cosmic naming contract, Compass duties, storage policy, RFC governance, agent surface.
- The closest nested `AGENTS.md` for each touched workspace (`docs/authoring/site-composition.md`, `packages/AGENTS.md`, `services/AGENTS.md`, or site-specific).
- `ref(forge.yaml bindings.paths.invariantsFile)` — all DNA invariants relevant to the touched files.
- `docs/requirements.xml`, `docs/technology.xml`, `docs/development-plan.xml` — if the diff is workspace-scoped or architectural.
- The `package.json` of each touched package — verify exports and dependencies.

Do not read every file in the repo — only the standards relevant to the diff.

### 4. Run the seven review axes

For each axis, check every item. An item either **passes**, **fails** (specific finding with evidence), or is **not applicable** (state why). Skip N/A items silently — do not pad the report.

#### Axis A — Structural correctness

Beyond what the mechanical floor catches:

- **Strict typing** — flag `any`, implicit casts, missing interfaces, untyped parameters, non-exhaustive switch/if chains.
- **No magic numbers or untyped data** — flag literal constants that should be named, enums, or config; flag strings standing in for domain concepts.
- **Minimalism** — flag over-engineered abstractions, speculative generality, duplicated logic, or middle-man modules that can be simplified.
- **Dead code** — flag unreachable branches, unused exports, commented-out code blocks.
- **Error handling** — flag swallowed errors, bare `catch` blocks without context, missing error types.
- **Fowler code smells** — the following baseline (from _Refactoring_, ch.3) applies always, even when a repo documents nothing. Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. A documented repo standard overrides the baseline; skip anything tooling already enforces.
  - **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
  - **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
  - **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
  - **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
  - **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
  - **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
  - **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
  - **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
  - **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
  - **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
  - **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
  - **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

#### Axis B — DNA alignment

Check the diff against every invariant it touches. The invariants are loaded in step 3 from `ref(forge.yaml bindings.paths.invariantsFile)`. Identify which invariants are relevant to the changed files by matching invariant scope to the diff's touched paths, file types, and architectural areas. Check each relevant invariant against the diff.

If the invariants file is absent or the optional binding is unresolvable, state "No invariants file — invariant alignment skipped" and skip this axis.

#### Axis C — Ecosystem fit

- **Package boundaries**: imports flow `apps/* → packages/*` and `services/* → packages/*`, never `apps/* → apps/*` or `apps/* → services/*`.
- **Pipeline placement**: new checks are placed in the correct pipeline (`build.prepare`, `build.check`, `sites-check`, `sites-check-postbuild`) with justified blocking vs. advisory choice.
- **Compass sync**: if the diff changes repository-wide requirements, shared package contracts, or app-package relationships, the relevant `docs/*.xml` files are updated.
- **AGENTS.md updates**: if the diff introduces new rules or patterns, the relevant `AGENTS.md` files are updated.
- **Cosmic naming**: if the diff touches manifests or component/section/page contracts, the three-way alignment is maintained.
- **Command lifecycle**: new commands are registered in the correct module; changed commands update their metadata; removed commands are explicitly deprecated.

#### Axis D — Forward-only compliance

- No compatibility shims, bridges, or dual-paths that keep legacy behavior alive.
- Deprecation means removal in the same change, not an indefinite grace period.
- Legacy code paths are deleted, not maintained behind a flag.
- If the diff amends an existing contract, it changes the contract directly — no parallel interpretation.

#### Axis E — Agent-facing clarity

- **Compass scaffolding**: new non-trivial source files carry `MODULE_CONTRACT` and `CHANGE_SUMMARY`; high-risk files carry `@ai-invariant` lines.
- **No ungrounded assertions**: code comments and docstrings reference real functions, types, and files — no invented APIs or phantom parameters.
- **Readable by another agent**: variable names reveal what they hold; function names reveal what they do; no mysterious names.
- **Log-driven development**: logs carry enough context for debugging; no bare `console.log` without context or structure. Prefer the repo's shared logging contracts when they exist.
- **Anti-fabrication**: if the diff includes content claims (prose, business records), the code distinguishes between generated content and human-authored content.

#### Axis F — Pragmatism

- **Minimal command surface**: each new command earns its existence — no command that could be a flag on an existing command.
- **Lean contracts**: TypeScript types are the minimum needed — no speculative generality, no unused optional fields.
- **Existing patterns**: the diff checks whether an existing command, schema, or pattern can be extended before introducing a new one.
- **Scope discipline**: the diff touches only what's necessary; no scope creep into unrelated areas.

#### Axis G — Blind spots

- **Performance**: new build-time commands specify their cost (file scan count, regex complexity, I/O patterns).
- **False positives**: new validators estimate their false-positive rate and describe suppression during migration.
- **Edge cases**: the diff considers empty states (new app with no content), concurrent execution, and interrupted operations.
- **Migration path**: existing apps' path to compliance is documented.
- **Security / privacy**: if the diff touches user data, PII, or external services, it addresses GDPR/privacy and secret management. No cookies (`document.cookie`, `Set-Cookie`). Client-side persistence is `localStorage` only; server-side is `unstorage`.

### 5. Check spec compliance

If an original request, spec, PRD, issue, or brief is available (from commit messages, linked issues, or session context), build a gap table:

| Requirement from the spec | Status                                 | Evidence |
| ------------------------- | -------------------------------------- | -------- |
| ...                       | Done / Partial / Missing / Scope creep | ...      |

- **Done** — the diff clearly satisfies it, with a quote or line reference.
- **Partial** — some part is missing, wrong, or incomplete.
- **Missing** — no trace in the diff.
- **Scope creep** — behavior present in the diff that was not requested.

If no spec is available, state: "No spec available — spec compliance skipped."

### 6. Produce the report

Present the findings in this structure in `aiLanguage`. **Translate all labels, headings, and axis names to `aiLanguage`** — the template below is structural only. Only identifiers (file paths, DNA invariant ids, RFC/ADR ids) stay untranslated. Keep it concise — each finding is one to three sentences with evidence (quote the code line, cite the file path, or reference the DNA invariant).

```
## <Code Review in aiLanguage>: <diff range or file list>

### Verdict: <Approved | Needs revision | Rejected>

<2-3 sentence justification grounded in the most serious findings.>

### Mechanical floor

<Pass / Fail — if fail, list errors.>

### Axis A — Structural correctness
<Findings or "No issues.">

### Axis B — DNA alignment
<Findings or "No issues.">

### Axis C — Ecosystem fit
<Findings or "No issues.">

### Axis D — Forward-only compliance
<Findings or "No issues.">

### Axis E — Agent-facing clarity
<Findings or "No issues.">

### Axis F — Pragmatism
<Findings or "No issues.">

### Axis G — Blind spots
<Findings or "No issues.">

### Spec compliance

<Gap table or "No spec available — skipped.">

### Questions for the author

1. <Hard question that the author must answer before merging.>
2. <Hard question.>
3. <Hard question.>
```

**Verdict criteria:**

- **Approved** — zero findings across all seven axes. Any finding, no matter how minor or cosmetic, disqualifies Approved and forces Needs revision. The rationale: downstream agents treat Approved as a stop signal and stop reading the findings — so even a trivial finding left under Approved gets silently ignored. If there is anything to fix, the verdict must say so.
- **Needs revision** — one or more findings on any axis, regardless of severity. A one-line cosmetic rename is enough. The agent must not downgrade to Approved based on severity — a finding is a finding.
- **Rejected** — fundamental flaw: the diff contradicts a DNA invariant, introduces a backward compatibility layer, or bypasses the storage policy.

### 7. Persist the review

Derive the `<module-folder>` from the reviewed files: take the package path with the most changed files and convert it to lowercase kebab-case (for example, `packages/growth` → `packages-growth`, `packages/os/site-kernel-checks` → `packages-os-site-kernel-checks`). For cross-workspace diffs, use the package with the largest number of changed files; list all reviewed files in the `filesReviewed` frontmatter field.

Write the report to:

```txt
docs/reviews/code/<module-folder>/review-<YYYY-MM-DD>-<HH>-<module-folder>.md
```

For example: `docs/reviews/code/packages-growth/review-2026-07-10-19-packages-growth.md`.

Create any missing parent directories. The file must begin with a YAML frontmatter block:

```yaml
---
reviewId: REVIEW-CODE-<YYYY-MM-DD>-<NN>
date: YYYY-MM-DD
reviewer:
  skill: fo-review
  model: <AI model identifier>
verdict: <approved | needs-revision | rejected>
diffRange: <fixed-point>...HEAD
filesReviewed:
  - <file path>
---

# Code Review: <diff range or file list>

(…report body…)
```

The `reviewer.model` field must record the AI model identifier the skill is running on (e.g. `claude-sonnet-4-20250514`, `gpt-4o`). If the model cannot be determined, use `unknown`.

If the file already exists, overwrite it — the review is always the latest run.

### 8. Stop

Do not modify any code or other file. Do not run `/fo-fix` — that is a separate skill. Present the report and stop. If the user asks to fix the findings, suggest running `/fo-fix` — it reads the persisted review and applies the fixes.

## Constraints

- The review is **read-only** with respect to all files — the only file it writes is the review report in `docs/reviews/code/`.
- The review does **not** duplicate the mechanical floor — it starts from the mechanical baseline and goes beyond it.
- The review does **not** assess writing style, prose quality, or formatting — only semantic and architectural correctness.
- The review does **not** approve or reject changes for merging — that is a human-only decision. The verdict is advisory.
- The review must ground every finding in evidence: quote the code line, cite the DNA invariant, or reference the file path. No ungrounded assertions.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — e.g. `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — do not stop and ask the user. Recover autonomously: split the content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".
