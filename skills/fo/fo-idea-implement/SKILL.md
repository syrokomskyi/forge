---
name: fo-idea-implement
description: Implement one or more RFCs or ADRs end-to-end. Detects document type by prefix and executes the appropriate flow. Use when the user asks to implement, realize, or execute a document.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc, commands.typecheck, commands.implementStamp]
  optional: [commands.test, commands.scopedBuild, paths.invariantsFile, paths.compassDocs]
triggers: ["implement this RFC", "execute the implementation plan", "realize this RFC end-to-end"]
---

# Implement RFC or ADR

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Execute the appropriate implementation flow based on the document type. RFCs go through the full pipeline (audit → enhance → plan → implement). ADRs have no plan file, no audit/enhance pipeline, and no acceptance criteria checkboxes — the decision is implemented directly. ADR lifecycle: `proposed → reviewing → accepted → implemented` (plus `superseded`/`rejected`).

## Process

### 1. Identify the document(s)

The user may provide:

- **A single id**: `RFC-XXXX`, `ADR-XXXX`, a filename, or a path.
- **A comma-separated list**: `RFC-XXXX, RFC-XXXX, ADR-XXXX` — process each in order.
- **A range**: `RFC-XXXX..RFC-XXXX` or `от RFC-XXXX до RFC-XXXX` — discover all files in `docs/rfcs/` whose numeric id falls within the inclusive range, sort ascending, and process each in order. Ranges are only valid within a single document type (RFC or ADR).
- **Nothing**: if a document file is open in the IDE, use it. Otherwise, ask.

When multiple documents are identified, **loop through each one** and run the full implementation flow for each sequentially **without pauses between documents**. Do not stop, present a summary, or ask the user between documents. Only after all documents are implemented, print a single final batch summary.

### 2. Classify: RFC or ADR

Determine the document type by:

1. **Prefix** — `RFC-` → RFC, `ADR-` → ADR.
2. **File location** — files in `docs/rfcs/` are RFCs, files in `docs/adrs/` are ADRs.
3. **Open file** — if the user provided nothing and a file is open in the IDE, check which directory it lives in.

If the type cannot be determined, ask the user.

### 3. RFC implementation flow

#### 3.1. Prerequisite checks (per RFC)

The pipeline is: create → audit → enhance → plan → implement. Audit, enhance, and a plan are **mandatory** — no RFC may proceed to implementation without all three being completed. The RFC must also be `accepted` — this skill does not transition `draft` to `accepted`; that is the responsibility of `fo-idea-plan`.

Before running the implementation on each RFC, perform these checks **in order**. If any check fails, record the RFC as **skipped** in the batch summary with the reason, and immediately proceed to the next RFC in the batch. Do not stop the entire batch — skip and report.

1. **Prefix check** — if the id starts with `ADR-`, this is not an RFC. Skip with message: `ADR-XXXX is an ADR, not an RFC. Use the ADR implementation flow (step 4 below) for ADR-XXXX.`
2. **RFC file exists** — look for `docs/rfcs/rfc-XXXX-*.md`. If no file is found, skip with message: `RFC-XXXX not found in docs/rfcs/. Run /fo-idea-create-rfc first.`
3. **Terminal status check** — read the RFC's `status` frontmatter. If the status is `implemented`, skip with message: `RFC-XXXX is already implemented. Nothing to do.` If the status is `rejected` or `superseded`, skip with message: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be implemented. To change this decision, create a new RFC with supersedes: [RFC-XXXX] via /fo-idea-create-rfc.`
4. **Audit check** — look for `docs/audits/audit-rfc-XXXX-*.md`. If no audit file exists, skip with message: `No audit report found for RFC-XXXX in docs/audits/. Run /fo-idea-audit RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`
5. **Enhance check** — read the RFC's frontmatter and look for the `enhancedAt` field. If `enhancedAt` is absent, skip with message: `RFC-XXXX has not been enhanced (no enhancedAt in frontmatter). Run /fo-idea-enhance RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`
6. **Accepted status check** — if the status is not `accepted` (e.g. `draft` or `reviewing`), skip with message: `RFC-XXXX is <status>, not accepted. Run /fo-idea-plan RFC-XXXX first — it will transition the RFC to accepted and create the plan. The pipeline is: create → audit → enhance → plan → implement.`
7. **Plan check** — look for `docs/plans/plan-rfc-XXXX-*.md`. If no plan file exists, skip with message: `No plan file found for RFC-XXXX in docs/plans/. Run /fo-idea-plan RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`

If all checks pass, proceed to step 3.2.

#### 3.2. Read the RFC and related context

Read the RFC fully and all RFCs listed in its `amends[]`, `related[]`, and `supersedes[]`. Read the plan fully. Read the closest `AGENTS.md` for each impacted package. Read `ref(forge.yaml bindings.paths.invariantsFile)` entries for every DNA invariant in `satisfies[]`.

If the plan or RFC has genuine ambiguities that would cause wrong implementation, ask the user **before starting implementation**. Use `ask_user_question` with a recommended option first. Once implementation begins, stop asking — make autonomous decisions.

#### 3.3. Implement step by step

Execute the plan's step sequence in order. For each step:

1. **Execute** the agent actions described in the step.
2. **Validate** — run the step's validation command (lightweight only: `rfc.validate`, type checks, unit tests on touched files). Do **not** run heavy checks (`root build`, `build:check`, `astro:check`) during implementation — they run only after all steps are complete.
3. **Commit** after each step or phase that produces a coherent, complete unit of work:

   ```txt
   implement: RFC-XXXX step N — <step title>

   <one-line description of what was done in this step>.
   ```

   Stage only the files touched by this step. Do not stage unrelated changes — another agent may be working in a different session.

**Implementation principles:**

- **No legacy, no backward compatibility.** Delete old code paths; do not maintain dual paths behind flags. The ecosystem is forward-only.
- **No pauses.** After implementation begins, make autonomous decisions aligned with the ecosystem: forward-only, minimal command surface, DNA-compliant, no shims.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — e.g. `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — do not stop and ask the user. Recover autonomously:
  - Split the content into smaller files or multiple `edit`/`multi_edit` calls.
  - Use `multi_edit` for several changes to one file instead of one giant block.
  - For oversized new files, decompose into focused modules and import them.
  - Retry the operation with the adjusted approach immediately. The operator's default answer to "Shall I proceed?" is always "yes" — so proceed without asking.
- **Commit only your own work.** If the working tree has changes from another session or agent, stage only the files relevant to the current step.
- **Compass scaffolding.** New non-trivial source files in `apps/` or `packages/` must carry `MODULE_CONTRACT` and `CHANGE_SUMMARY` scaffolding. Check the project's invariants file for the canonical Compass markup rule.
- **Compass terminology.** Use Compass (not GRACE) in all new code, documentation, and log messages.

#### 3.4. Run heavy checks

After **all** plan steps are complete, run the heavy validation suite in order:

1. **RFC validation:**

   ```sh
   ref(forge.yaml bindings.commands.validateRfc) --json
   ```

2. **Package-level build checks** for each impacted package:

   ```sh
   ref(forge.yaml bindings.commands.typecheck) --workspace=<package>
   ```

3. **App-level checks** for each impacted app:

   ```sh
   pnpm --filter <app-name> run build:check
   ```

Use the `packagesImpacted` and `appsImpacted` frontmatter lists to determine which workspaces to check. If the RFC does not list impacted workspaces, infer them from the plan's step sequence (which files were touched in which packages).

**Do not run a full root `root build` or `turbo run build`.** The success criterion is that all impacted workspaces pass their scoped checks, not that the entire ecosystem builds. See root AGENTS.md §Build verification discipline.

#### 3.5. Fix errors

If any check in step 3.4 fails, fix every error:

1. Read the error output.
2. Identify the root cause.
3. Fix it.
4. Re-run the failing check to confirm the fix.
5. Commit each fix:

   ```txt
   fix: RFC-XXXX — <error description>

   <one-line description of the root cause and fix>.
   ```

6. If the error is pre-existing (not caused by this RFC's implementation) and is in an impacted workspace, fix it. If the error is in an unimpacted workspace, skip it — it is not this RFC's responsibility.

Continue until all impacted checks pass.

#### 3.6. Check acceptance criteria

Read the RFC's `## Acceptance criteria` section. For each checkbox:

1. **Verify the criterion is met semantically** — check the code does what the criterion says, run the relevant command, or inspect the artifact. Mechanical existence (command registered, test passes) is NOT sufficient. The criterion must describe observable behavior that the RFC defines, not just that a command exists.
2. **Check for stubs** — if the code contains TODO, stub, not-implemented, or placeholder logic in the path the criterion covers, the criterion is NOT met. Implement the real logic before marking it.
3. **If a criterion is not met**, implement the missing work, commit it, and re-verify.
4. **Annotate every `[x]` with inline evidence** — add `(evidence: <file-path:line>, <test-or-command>)` to each checked criterion. This is enforced by V-27.
5. **If a criterion cannot be met** (e.g., requires an external dependency not yet available, requires a pilot that is not registered), do NOT mark it `[x]` and do NOT stamp `implemented`. Instead, split the deferred work into a follow-up RFC via `rfc.supersede.propose`. An RFC with unchecked `[ ]` criteria cannot transition to `implemented` — this is enforced by V-26.

Do not proceed to step 3.7 until every acceptance criterion checkbox is checked with evidence.

#### 3.7. Run acceptance probes and emit evidence

If the RFC declares `acceptance:` probes in frontmatter:

```sh
ref(forge.yaml bindings.commands.validateRfc) --acceptance.run --id RFC-XXXX
```

If the RFC was created on or after 2026-07-07 and has acceptance probes:

```sh
ref(forge.yaml bindings.commands.validateRfc) --verification.emit --id RFC-XXXX
```

Commit the evidence file:

```txt
evidence: RFC-XXXX verification artifact

Emit per-RFC verification evidence for RFC-XXXX implementation.
```

Stage `docs/rfcs/verification/rfc-xxxx.generated.json`.

#### 3.8. Stamp implemented

Transition the RFC to `implemented` using the `rfc.implement.stamp` command. Direct edits to `status`, `implementedAt`, and `updatedAt` are prohibited for all actors.

1. Ensure the working tree is clean (all implementation changes committed).
2. Identify the implementation commit SHA — the commit that contains the core implementation work and references the RFC id in its message or changed files.
3. Run the stamp command:

   ```sh
   ref(forge.yaml bindings.commands.implementStamp) --id RFC-XXXX --implementation-commit <sha>
   ```

   The command atomically validates all preconditions (accepted status, checked+evidenced criteria, clean tree, reachable RFC-referencing commit, passing probe evidence) and sets `status: implemented`, `implementedAt`, and `updatedAt` in one atomic write.

4. Commit the stamped RFC file:

   ```txt
   rfc: implement RFC-XXXX <short title>

   Transition RFC-XXXX to implemented status via rfc.implement.stamp.
   All acceptance criteria met, verification evidence emitted, scoped build passes.
   ```

   Stage only the RFC file. The implementation commit and the stamp commit MUST be separate.

#### 3.9. Documentation audit (fo-doc-audit)

After implementation is complete and all checks pass, invoke `fo-doc-audit` via the `skill` tool. It analyzes the session's changes, checks all documentation surfaces (AGENTS.md, README, Compass XML, architecture-dna.md, templates, generated artifacts, COMMANDS.md/PACKAGE_GRAPH.md), applies needed updates, and commits them separately. Wait for it to complete.

If `fo-doc-audit` reports that no updates are needed, proceed to the next step.

#### 3.10. Code review (fo-review)

After the documentation audit, invoke `fo-review` via the `skill` tool. It performs a cross-session fitness check of the code diff against Forge standards (DNA, forward-only, Compass, agent clarity, pragmatism). The review covers all code changes made in this session since the first implementation commit.

1. Determine the diff range: `git diff <merge-base-of-session>...HEAD` — where merge-base is the commit before the first `implement:` commit for this RFC.
2. Invoke `fo-review` with the diff range. Wait for it to complete (persist + commit the review report in `docs/reviews/code/`).
3. Read the review report. If the verdict is `approved` **and** the report contains zero findings across all axes, proceed to step 3.12.
4. If the review has **any** findings — even a single cosmetic observation on any axis — proceed to step 3.11 (fix). Do not interpret an `approved` verdict as "no findings" — read the axis sections and count every finding, including ones labelled "minor" or "cosmetic".

**This step is MANDATORY.** Do not skip it, even if the implementation seems clean. The review is the quality gate that catches DNA misalignment, forward-only violations, Compass drift, and agent clarity issues that implementation authors miss.

#### 3.11. Fix review findings (fo-fix)

If `fo-review` (step 3.10) reported **any** findings (even cosmetic ones on axes A/C/F/G), invoke `fo-fix` via the `skill` tool. It applies the review findings iteratively: fix → typecheck → commit → re-check.

1. Invoke `fo-fix` with the review report. Wait for it to complete.
2. After `fo-fix` returns, re-run `fo-review` to confirm all findings are resolved.
3. If new findings appear, repeat the fix cycle. Maximum 3 iterations.
4. If findings persist after 3 iterations, stop and report to the operator.

If `fo-review` reported truly zero findings (the report explicitly states "No issues." on every axis), skip this step. An `approved` verdict with any finding text on any axis does NOT qualify as zero findings.

#### 3.11b. Implementation status gate (RFC)

Before reporting completion, verify the RFC has been stamped as `implemented`:

1. Read the RFC frontmatter — confirm `status: implemented` and `implementedAt` is set.
2. Run `ref(forge.yaml bindings.commands.validateRfc) --id RFC-XXXX --json` — confirm zero errors.
3. If status is not `implemented`, go back to step 3.8 (Stamp implemented) and run the stamp command.
4. If `rfc.validate` reports errors, fix them before proceeding.

This gate is MANDATORY. Do not proceed to step 3.12 (report) until the RFC is `implemented`.

#### 3.12. RFC report

After implementation is complete, report in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only. Only identifiers (RFC-XXXX, file paths, skill names) stay untranslated.

```
## <RFC-XXXX Implementation Summary in aiLanguage>

### Plan: <found>
### Steps implemented: <count>
### Commits: <count>
### Acceptance criteria: <count> / <count> met
### Verification evidence: <emitted | not required>
### Heavy checks: scoped build <Pass | Fail — fixed>
### Code review: <pass | pass with N findings fixed | needs attention>
### Status: implemented (<date>)
```

### 4. ADR implementation flow

Execute this flow when the document is an ADR (prefix `ADR-`, or file in `docs/adrs/`).

#### 4.1. Read the ADR

Read the ADR file. Extract:

- **Status** — must be `accepted`, `reviewing`, or `proposed`. If `superseded` or `rejected` (terminal), stop with message: `ADR-XXXX is <status> (terminal). Terminal ADRs cannot be implemented. To change this decision, create a new ADR or RFC that supersedes ADR-XXXX.` If `implemented`, stop with message: `ADR-XXXX is already implemented. Nothing to do.`
- **Decision** — the core decision from the `## Decision` section.
- **Context** — the local situation and constraints from `## Context`.
- **Consequences** — what the decision implies for the codebase.
- **Related** — any RFCs, ADRs, or DNA invariants referenced.

#### 4.2. Transition to accepted (if needed)

If the ADR is `proposed` or `reviewing`, transition it to `accepted`:

1. Set `status: accepted` in the frontmatter.
2. Set `updatedAt: <today's date>`.
3. If `reviewers` is empty, read the default reviewer(s) from the `reviewers` field comment in `docs/adrs/adr-0000-template.md` (currently `human:andrii-syrokomskyi`). Set all listed default reviewers.
4. Commit:

   ```txt
   adr: accept ADR-XXXX <short title>

   Transition ADR-XXXX to accepted status for implementation.
   ```

   Stage only the ADR file.

If the ADR is already `accepted`, proceed directly.

#### 4.3. Implement the decision

Read the `## Decision` section and implement it in code. Follow the same principles as RFC implementation:

- Make autonomous, ecosystem-aligned decisions.
- Use `edit`/`multi_edit` for changes to existing files, `write_to_file` for new files.
- Commit each logical phase of work:

  ```txt
  implement: ADR-XXXX — <phase description>

  <one-line description of what was done in this phase>.
  ```

  Stage only the files touched by this phase. Do not stage unrelated changes — another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

- If a tool call fails with a recoverable error, recover autonomously: split content, use `edit`/`multi_edit`, decompose files, and retry immediately.

#### 4.4. Run scoped build checks

After implementation is complete, run heavy checks for the impacted workspaces only:

1. ADR validation:

   ```sh
   ref(forge.yaml bindings.commands.validateAdr) <adr-id> --json
   ```

2. Determine impacted packages/apps from the ADR's `scope` and the files touched during implementation. Build only those workspaces:

   ```sh
   ref(forge.yaml bindings.commands.typecheck) --workspace=<package>
   ```

   Or for apps:

   ```sh
   pnpm --filter <app-name> run build:check
   ```

   **MUST NOT run a full root `root build` or `turbo run build`.** Only check the workspaces this ADR touches. See root AGENTS.md §Build verification discipline.

#### 4.5. Fix errors

If any check fails, fix every error:

1. Read the error output.
2. Identify the root cause.
3. Fix it.
4. Re-run the failing check to confirm the fix.
5. Commit each fix:

   ```txt
   fix: ADR-XXXX — <error description>

   <one-line description of the root cause and fix>.
   ```

Continue until all impacted checks pass.

#### 4.6. Documentation audit (fo-doc-audit)

After implementation is complete and all checks pass, invoke `fo-doc-audit` via the `skill` tool. It analyzes the session's changes, checks all documentation surfaces, applies needed updates, and commits them separately. Wait for it to complete.

If `fo-doc-audit` reports that no updates are needed, proceed to the next step.

#### 4.7. Code review (fo-review)

After the documentation audit, invoke `fo-review` via the `skill` tool. It performs a cross-session fitness check of the code diff against Forge standards. The review covers all code changes made in this session.

1. Determine the diff range: `git diff <merge-base-of-session>...HEAD`.
2. Invoke `fo-review` with the diff range. Wait for it to complete (persist + commit the review report).
3. Read the review report. If the verdict is `approved` **and** the report contains zero findings across all axes, proceed to step 4.9.
4. If the review has **any** findings — even a single cosmetic observation on any axis — proceed to step 4.8 (fix). Do not interpret an `approved` verdict as "no findings" — read the axis sections and count every finding.

**This step is MANDATORY.** Do not skip it.

#### 4.8. Fix review findings (fo-fix)

If `fo-review` (step 4.7) reported **any** findings (even cosmetic ones), invoke `fo-fix` via the `skill` tool.

1. Invoke `fo-fix` with the review report. Wait for it to complete.
2. After `fo-fix` returns, re-run `fo-review` to confirm all findings are resolved.
3. If new findings appear, repeat the fix cycle. Maximum 3 iterations.
4. If findings persist after 3 iterations, stop and report to the operator.

If `fo-review` reported truly zero findings (the report explicitly states "No issues." on every axis), skip this step. An `approved` verdict with any finding text on any axis does NOT qualify as zero findings.

#### 4.9. ADR code-trace

Before stamping `implemented`, verify that the ADR is mentioned in the codebase — this leaves a trace linking code back to the decision record, just as RFCs leave traces.

1. **Search for the ADR id** — use `grep_search` to scan `apps/`, `packages/`, and `services/` for the ADR id string (e.g. `ADR-XXXX`). Check:
   - **COMPASS block comments** — `MODULE_CONTRACT`, `CHANGE_SUMMARY`, or other Compass scaffolding comments that reference the ADR id.
   - **Inline code mentions** — comments, docstrings, or annotations in source files that reference the ADR id.

2. **If mentions are found** — the trace exists. Proceed to step 4.10.

3. **If no mentions are found** — attempt to find the most relevant file(s) where the decision was implemented. If the file(s) can be identified:
   - Add a Compass block comment referencing the ADR id to the file's `MODULE_CONTRACT` or `CHANGE_SUMMARY` section. For example: `<item>ADR-XXXX: <brief note on what this ADR decided for this module.</item>`
   - If the file has no Compass scaffolding, add a brief inline comment at the top of the file: `// Implements ADR-XXXX: <one-line decision summary>`
   - Commit the trace:

     ```txt
     trace: ADR-XXXX — add code mention

     Add ADR-XXXX reference to <file> to link the decision to the code.
     ```

   - Proceed to step 4.10.

4. **If the relevant file(s) cannot be identified** — ask the operator: `ADR-XXXX was implemented but no code mention was found. Please point to the file(s) where this ADR's decision was applied so I can add a trace reference.` After the operator provides the file(s), add the trace as described in step 3, commit, and proceed.

**For already-implemented ADRs** (if this step is reached for an ADR that was already `implemented`): this check is informational — attempt to find the trace and add it if missing, but do not block on it.

#### 4.10. Stamp implemented

After all checks pass and documentation is updated, transition the ADR to `implemented`:

1. Set `status: implemented` in the frontmatter.
2. Set `implementedAt: <today's date>`.
3. Set `updatedAt: <today's date>`.
4. Commit:

   ```txt
   adr: implement ADR-XXXX <short title>

   Transition ADR-XXXX to implemented status. Decision is live in code,
   scoped build passes.
   ```

   Stage only the ADR file.

#### 4.10b. Implementation status gate (ADR)

Before reporting completion, verify the ADR has been transitioned to `implemented`:

1. Read the ADR frontmatter — confirm `status: implemented` and `implementedAt` is set.
2. Run `ref(forge.yaml bindings.commands.validateAdr) --id ADR-XXXX --json` — confirm zero errors.
3. If status is not `implemented`, go back to step 4.10 (Stamp implemented) and set `status: implemented`, `implementedAt`, `updatedAt`.
4. If `adr.validate` reports errors, fix them before proceeding.

This gate is MANDATORY. Do not proceed to step 4.11 (report) until the ADR is `implemented`.

#### 4.11. Report

After implementation is complete, report in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only.

```
## <ADR-XXXX Implementation Summary in aiLanguage>

### Decision: <one-line summary>
### Phases implemented: <count>
### Commits: <count>
### Scoped build: <Pass | Fail — fixed>
### Code review: <pass | pass with N findings fixed | needs attention>
### Status: implemented (<date>)
```

### 5. Batch summary

If multiple documents were processed, present a single batch summary at the very end in `aiLanguage`. **Translate all labels, headings, and column names to `aiLanguage`** — the template below is structural only.

```
## <Batch Implementation Summary in aiLanguage>

### Documents requested: <N>
### Documents implemented: <N>

| ID | Type | Status | Commits | Build |
| --- | --- | --- | --- | --- |
| RFC-XXXX | RFC | implemented | 3 | pass |
| ADR-XXXX | ADR | implemented | 2 | pass |
...

### Total commits: <count>
```

Do not output per-document summaries or "Moving to XXXX next" messages during the loop; they belong here, at the very end.

## Constraints

- **Commit only your own files.** Stage only the files this skill produces or modifies — document files, code files touched by implementation, documentation files. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- **Classify before executing.** Do not run both flows — pick one based on the prefix or file location.
- **No pauses after implementation begins.** Make autonomous, ecosystem-aligned decisions. The user said "поехали" — keep going.
- **No legacy, no backward compatibility.** Delete old paths; do not maintain dual paths. The ecosystem is forward-only.
- **No heavy checks during implementation.** `build:check`, `astro:check` run only after all implementation phases are complete. Lightweight checks (`adr.validate`, `rfc.validate`, type checks, unit tests on touched files) are fine during implementation.
- **Scoped checks must pass.** Only check the workspaces this document touches. **MUST NOT run a full root `root build` or `turbo run build`** — see root AGENTS.md §Build verification discipline. Pre-existing errors in unimpacted workspaces are not this document's responsibility.
- **Do not weaken DNA invariants.** If implementation reveals an invariant conflict, escalate via `rfc.supersede.propose` instead of working around it.
- **Compass scaffolding on new files.** Non-trivial new source files in `apps/` or `packages/` must carry `MODULE_CONTRACT` and `CHANGE_SUMMARY`. Check the project's invariants file for the canonical Compass markup rule.
- **Compass terminology, not GRACE.** Use Compass in all new code, docs, and log messages.
- **Review and fix are MANDATORY.** After implementation and doc-audit, always run `fo-review` (step 3.10 / 4.7) and `fo-fix` (step 3.11 / 4.8) if **any** findings exist in the review report — including cosmetic or minor findings. Do not stamp `implemented` without a review report in `docs/reviews/code/`. An `approved` verdict does NOT mean "skip fix" — read every axis section and count every finding. This is the quality gate that catches DNA misalignment, forward-only violations, and Compass drift.
- **No `draft → accepted` transition for RFCs.** This skill requires RFC `status: accepted` and does not transition RFCs. Use `/fo-idea-plan` for that transition.
