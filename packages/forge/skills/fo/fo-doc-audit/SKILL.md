---
name: fo-doc-audit
description: Audit session changes and update AGENTS.md, README, Compass XML, architecture-dna.md, and templates so AI and human docs stay in sync with code. Use at session end or inline by other skills.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [paths.invariantsFile, paths.compassDocs]
triggers: ["audit documentation sync", "update docs after code changes", "check AGENTS.md and README are in sync"]
---

# Documentation Audit

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Analyze the current session's code and content changes, determine which documentation surfaces are out of sync, apply updates, and commit. This skill is the single source of truth for the "are docs still accurate?" question that every session ends on.

## When to invoke

- **Standalone at session end** — the operator runs `/fo-doc-audit` after completing work to ensure docs reflect the changes.
- **Inline by other skills** — `fo-fix`, `fo-idea-implement`, and other skills delegate their doc-update steps here instead of carrying inline logic.

## Documentation surfaces

The ecosystem has seven documentation surfaces. Each has a different audience and update trigger.

| Surface | Path pattern | Audience | Update trigger |
| --- | --- | --- | --- |
| **AGENTS.md** | root, `apps/`, `packages/`, `services/`, nested workspace | AI agents | Contract, convention, workflow, pipeline, command, or boundary change |
| **README** | root, `packages/*/README.md`, `services/*/README.md` | Humans (developers, operators) | Public API, CLI surface, usage pattern, or installation flow change |
| **Compass XML** | `docs/requirements.xml`, `docs/technology.xml`, `docs/development-plan.xml`, `docs/knowledge-graph.xml`, `docs/verification-plan.xml`, `docs/source-markup.xml` | AI agents (machine-readable semantic layer) | Repository-wide requirements, shared package contracts, app-package relationships, verification policy |
| **architecture-dna.md** | `ref(forge.yaml bindings.paths.invariantsFile)` | AI agents + humans | New DNA invariant, invariant amendment, or invariant retirement |
| **Templates** | `packages/os/site-kernel-onboarding/src/templates/`, `packages/os/site-kernel-codegen/src/templates/` | Future apps/packages (scaffold time) | Change to what a new app or package should look like at creation time |
| **Generated artifacts** | `docs/ecosystem.generated.json`, `docs/command-manifest.generated.yaml`, `fleet/*.generated.yaml`, `*.generated.css` | AI agents (read-only projection) | **Never edit directly** — update the generator or registry, then regenerate |
| **COMMANDS / PACKAGE_GRAPH** | `docs/COMMANDS.md`, `docs/PACKAGE_GRAPH.md` | Humans + AI agents | New command, removed command, package graph change |

## Process

### 1. Gather session context

Determine what changed in this session. Use in priority order:

1. **Explicit scope** — if the operator or calling skill specified a git fixed point, diff range, or file list, use it.
2. **Git diff** — run `git diff HEAD` (unstaged) and `git diff --cached` (staged) to see uncommitted changes. Run `git log --oneline -10` to see recent commits in this session.
3. **Session conversation** — scan the current conversation for files modified, commands run, and artifacts created.

Capture the full list of changed files and categorize them:

- **Code** — `.ts`, `.js`, `.mjs`, `.astro`, `.css`, `.json`, `.yaml`, etc.
- **Content** — `src/content/**/*.md`, `src/content/**/*.yaml`.
- **Docs** — `docs/**/*.md`, `docs/**/*.xml`, `AGENTS.md`, `README.md`.
- **Templates** — files under `packages/os/site-kernel-*/src/templates/`.
- **Generated** — `*.generated.*`, `fleet/*.generated.*`.

### 2. Run impact analysis

For each documentation surface, determine whether it needs updating. Answer the trigger questions below. If any answer is "yes", that surface needs an update.

#### 2a. AGENTS.md

- Did a **contract, convention, or workflow** change that agents rely on?
- Were **files, packages, commands, or pipelines** added, removed, or renamed?
- Did **build steps, verification commands, or environment requirements** change?
- Was a **new pattern** introduced that other agents working in the same area should know about?
- Did **package boundaries or import rules** change?
- Did the **RFC governance protocol, storage policy, cosmic naming contract, or Compass duties** change?

If yes for a specific workspace, identify the **nearest applicable AGENTS.md**:

- Root `AGENTS.md` — monorepo-wide rules.
- `docs/authoring/site-composition.md` — shared site rules.
- `packages/AGENTS.md` — shared package rules.
- `services/AGENTS.md` — shared backend runtime rules.
- `<site>/AGENTS.md` or `packages/<pkg>/AGENTS.md` — workspace-specific rules.

Update only the nearest applicable file(s). Do not duplicate rules across levels — root stays cross-workspace, nested stays workspace-specific.

#### 2b. README

- Did a package's **public API** (exports, types, functions) change?
- Did a **CLI surface** change (new command, removed command, changed flags)?
- Did **usage patterns** change (how someone imports, calls, or configures the package)?
- Did the **installation or setup flow** change?
- Did the **root README** need updating (project overview, getting started, architecture summary)?

If yes, update the relevant `README.md`. Keep READMEs concise — they are human-facing quick-start guides, not exhaustive references.

#### 2c. Compass XML

Per root AGENTS.md §Compass document duties: keep `docs/*.xml` synchronized with the current codebase. Check:

- **`docs/requirements.xml`** — did repository-wide requirements change?
- **`docs/technology.xml`** — did the technology stack, frameworks, or tooling change?
- **`docs/development-plan.xml`** — did the development plan or milestone structure change?
- **`docs/knowledge-graph.xml`** — did the knowledge graph structure or relationships change?
- **`docs/verification-plan.xml`** — did the verification flow, check pipelines, or validation policy change?
- **`docs/source-markup.xml`** — did the source-file Compass contract (markup patterns, anchor conventions) change?

If yes, update the affected XML file(s). These are the primary machine-readable semantic layer — keep them precise.

#### 2d. architecture-dna.md

- Was a **new invariant** introduced (e.g., a new entry in the project's invariants file)?
- Was an **existing invariant amended** (e.g., broadened scope, tightened rule)?
- Was an **invariant retired** (forward-only removal)?

If yes, update `ref(forge.yaml bindings.paths.invariantsFile)`. If a new invariant was introduced, also check whether `docs/source-markup.xml` needs a corresponding entry.

#### 2e. Templates

- Did the change affect **what a new app or package should look like at scaffold time**?
- Did a **boilerplate file, script, or config** pattern change that onboarding/codegen templates should reflect?
- Did a **new convention** get introduced that future apps/packages must follow from creation?

If yes, update the **template** files in `packages/os/site-kernel-onboarding/src/templates/` and `packages/os/site-kernel-codegen/src/templates/`. **Never edit generated output in existing apps** — fix the template, then regenerate if needed.

#### 2f. Generated artifacts

- Did a **registry** change (`systems/registry.yaml`, `fleet/fleet.sites.yaml`, command module registrations)?
- Did a **generator input** change (package manifests, command tables, fleet plan)?

If yes, **do not edit the generated file directly**. Update the source registry or generator, then run the regeneration command:

```sh
ref(forge.yaml bindings.commands.scopedBuild) --workspace=ecosystem.manifest.generate
ref(forge.yaml bindings.commands.scopedBuild) --workspace=command.manifest.generate
```

Note: if the regeneration command is expensive or unavailable in the current session, document the need to regenerate in the session summary and move on.

#### 2g. COMMANDS.md / PACKAGE_GRAPH.md

- Were **commands** added, removed, or renamed?
- Did the **package graph** change (new package, removed package, new dependency)?

If yes, update `docs/COMMANDS.md` and/or `docs/PACKAGE_GRAPH.md`. If these are generated, update the generator instead (see 2f).

### 3. Present analysis to the operator

Present the impact analysis as a concise table before applying any changes. This gives the operator a chance to correct the assessment.

```
## Documentation Impact Analysis

| Surface | Needs update? | Reason |
| --- | --- | --- |
| AGENTS.md (root) | Yes | New command lifecycle rule |
| AGENTS.md (packages/os/site-kernel) | Yes | New cache module registered |
| README (packages/os/site-kernel) | No | No public API change |
| Compass XML (docs/verification-plan.xml) | Yes | New check pipeline stage |
| architecture-dna.md | No | No DNA invariant change |
| Templates | No | No scaffold-time change |
| Generated artifacts | Yes | Command manifest needs regeneration |
| COMMANDS.md | Yes | Two new commands added |
```

If no surface needs updating, state this explicitly and stop:

> "Документация актуальна — обновления не требуются."

If the operator confirms (or if running inline and the calling skill's conventions apply), proceed to step 4.

### 4. Apply updates

For each surface that needs updating:

1. **Read** the target file before editing.
2. **Edit** with minimal, focused changes — follow the existing structure and tone.
3. **Do not delete existing content** unless it describes a removed feature (forward-only: delete stale docs, do not leave them as historical notes).
4. **Do not add comments or documentation** to code files unless the task explicitly requires it.
5. **Generated files**: update the source (registry/generator/template), not the generated output. Run the regeneration command if available.

**Forward-only rule**: if a feature, command, or pattern was removed in this session, remove all documentation references to it. Do not keep "legacy" or "deprecated" sections — the ecosystem is forward-only.

**Compass scaffolding**: if new non-trivial source files were added in the session, ensure they carry `MODULE_CONTRACT` and `CHANGE_SUMMARY` scaffolding. Check the project's invariants file for the canonical Compass markup rule. This is part of documentation audit — Compass markup is a documentation surface.

### 5. Verify generated artifacts

If any generated artifact needed regeneration (step 2f), run the generator now:

```sh
ref(forge.yaml bindings.commands.scopedBuild) --workspace=ecosystem.manifest.generate
ref(forge.yaml bindings.commands.scopedBuild) --workspace=command.manifest.generate
```

If the generator command is unavailable or too expensive for this session, note it in the summary — the operator can regenerate later.

If a generated artifact was regenerated, run the drift guards:

```sh
ref(forge.yaml bindings.commands.scopedBuild) --workspace=ecosystem.manifest.validate
ref(forge.yaml bindings.commands.scopedBuild) --workspace=workspace.surface.validate
```

### 6. Commit

Stage and commit documentation changes separately from code changes. Use focused commit messages:

```txt
docs: update AGENTS.md and Compass XML for <what changed>

<one-line description of which docs were updated and why>.
```

If multiple surfaces were updated, list them in the commit body:

```txt
docs: sync documentation for <feature/RFC>

- AGENTS.md (root): <what changed>
- docs/verification-plan.xml: <what changed>
- docs/COMMANDS.md: <what changed>
- packages/os/site-kernel/README.md: <what changed>
```

Stage only the documentation files touched by this step. Do not stage unrelated changes — another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

If no documentation changes were needed, skip this step.

### 7. Report

Present a concise summary in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only.

```
## <Documentation Audit Summary in aiLanguage>

### Surfaces checked: <count>
### Surfaces updated: <count>
- <surface>: <one-line description of change>
### Generated artifacts regenerated: <count | skipped — reason>
### Commit: <hash | none — no changes needed>
```

## Inline invocation by other skills

When another skill (e.g. `fo-fix`, `fo-idea-implement`) delegates its doc-update step to `fo-doc-audit`:

1. The calling skill invokes `fo-doc-audit` via the `skill` tool.
2. `fo-doc-audit` runs its full process (steps 1–7).
3. The calling skill does **not** duplicate the doc-update logic — it trusts `fo-doc-audit` to cover all surfaces.
4. The calling skill's completion criteria should reference `fo-doc-audit` instead of inline checks.

Skills that delegate to `fo-doc-audit`:

- **`fo-fix`** step 5 ("Documentation audit") — invokes `fo-doc-audit`.
- **`fo-fix`** merge conflict resolution step 4 ("Documentation audit") — invokes `fo-doc-audit`.
- **`fo-idea-implement`** step 3.9 ("Documentation audit") — invokes `fo-doc-audit`.
- **`fo-idea-implement`** ADR-FLOW step 4.6 ("Documentation audit") — invokes `fo-doc-audit`.

## Constraints

- **Templates, not generated files.** Never edit `*.generated.*` directly — update the source and regenerate.
- **Forward-only.** Delete documentation for removed features; do not keep stale references.
- **Minimal edits.** Update only what is out of sync. Do not rewrite sections that are still accurate.
- **No code comments.** Do not add or delete comments in code files unless the task explicitly requires it.
- **Compass scaffolding is part of docs.** New non-trivial source files must carry `MODULE_CONTRACT` and `CHANGE_SUMMARY`. Check the project's invariants file for the canonical Compass markup rule.
- **Commit discipline.** Stage only documentation files. Do not stage unrelated changes — another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- **Read before edit.** Always read the target file before editing to preserve structure and tone.
- **Generated artifact regeneration is best-effort.** If the generator command is unavailable or too expensive, note it and move on — do not block the session.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — recover autonomously: split content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".
- **Session summary.** End every session with a closing block in the operator's `aiLanguage`: a 1–3 sentence summary of what was done, followed by 1–3 copy-pasteable next-step slash commands with short explanations.
