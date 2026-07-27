---
name: fo-idea-i-just-want-to-see-the-result
description: Orchestrate the full feature pipeline (idea, audit, enhance, plan, implement, review, fix) in one invocation. Accepts a raw idea or RFC/ADR id. Use when the operator wants the complete pipeline.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggers: ["I just want to see the result", "run the full pipeline automatically", "implement this end-to-end without pauses"]
---

# Full Pipeline — Just Want to See the Result

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

See `_shared/fo-pipeline-conventions.md` §Language policy.

This skill is a **pure orchestrator** — it delegates every step to the appropriate skill.

## stopAfter contract

This orchestrator supports a `stopAfter` parameter that limits how far the pipeline runs:

- **`stopAfter: plan`** — execute steps 0–3 only (idea, audit, enhance, plan). Do not run implement (step 4), which now includes review and fix. After step 3 completes, report the summary and stop.
- **`stopAfter: null` (default)** — run the full pipeline through implement (which includes review and fix).

When `stopAfter: plan` is set and the document is an **ADR**, the ADR pipeline skips audit/enhance/plan. Stop after step 0 (idea creation) with the message: "ADR does not require a plan. Run `/fo-idea-implement` to implement."

When resuming with `stopAfter: plan`, if the plan file already exists in `docs/plans/plan-rfc-XXXX-*.md`, stop immediately — do not proceed to implement.

## Preconditions

The operator may provide either:

- **A raw idea** — natural-language description of a feature, change, or decision. The skill will invoke `fo-idea` as step 0 to create the RFC/ADR first.
- **An existing RFC/ADR id** — e.g. `RFC-XXXX` or `ADR-XXXX`. The skill skips idea creation and starts the pipeline from the appropriate step.
- **Nothing** — if neither is provided, check session context and IDE for a recently created document. If none found, ask the operator: "Какую идею реализуем? Опишите идею или укажите RFC-XXXX / ADR-XXXX."

## Process

### 0. Idea creation (conditional)

Determine whether the operator provided a raw idea or a document id:

1. **Document id detected** — if the operator's input contains `RFC-XXXX` or `ADR-XXXX`, skip this step. Record the id and proceed to step 1.
2. **Session context** — look for the most recent `fo-idea` or `fo-idea-create-rfc` / `fo-idea-create-adr` invocation in the current session. If found, extract the document id(s) from its output and proceed to step 1.
3. **IDE context** — if a document file (`docs/rfcs/rfc-XXXX-*.md` or `docs/adrs/adr-XXXX-*.md`) is open in the IDE, use it and proceed to step 1.
4. **Raw idea** — if the operator provided natural-language text that is not a document id, invoke `fo-idea` with the idea text. Wait for it to complete (classify, grill, create RFC/ADR, commit). Extract the document id(s) from its output. Then proceed to step 1.
5. **Nothing** — ask the operator (in `aiLanguage`): "What idea should we implement? Describe the idea or specify RFC-XXXX / ADR-XXXX."

Record the document id(s) and type(s) (RFC or ADR). If multiple documents were created in a series, process them in dependency order — the same order `fo-idea` created them.

### 1. Run the pipeline

For each document, run the full pipeline inline. The pipeline differs for RFCs and ADRs.

#### RFC pipeline

Execute these steps **in order**, invoking each skill inline via the `skill` tool. Do not stop between steps. Do not ask the operator "shall I proceed?" between steps — the operator's invocation of this skill IS the instruction to proceed through the entire pipeline.

**Step 1 — Audit**

Invoke `fo-idea-audit` on the RFC. Pass the RFC id. Wait for it to complete (persist + commit the audit report).

**Step 2 — Enhance**

Invoke `fo-idea-enhance` on the RFC. Pass the RFC id. Wait for it to complete (apply findings, resolve questions, grill, commit).

**Step 3 — Plan**

Invoke `fo-idea-plan` on the RFC. Pass the RFC id. This transitions the RFC to `accepted` and creates the plan file. Wait for it to complete (explore codebase, resolve open questions, grill the plan, persist + commit).

**Step 4 — Implement (includes review and fix)**

Invoke `fo-idea-implement` on the RFC. Pass the RFC id. Wait for it to complete. `fo-idea-implement` now runs the full implementation → review → fix cycle internally:

- Execute plan steps, run heavy checks, fix errors, check acceptance criteria, emit evidence, update docs, stamp implemented + commit.
- Run `fo-review` on all session code changes.
- Run `fo-fix` if the review has findings.

Do not invoke `fo-review` or `fo-fix` separately — they are built into `fo-idea-implement`.

**Fallback verification (MANDATORY).** After `fo-idea-implement` returns, verify that review and fix were actually executed:

1. Check for a review report in `docs/reviews/code/` dated today or with a `diffRange` covering this session's commits.
2. If no review report exists, invoke `fo-review` with scope: all code changes made in this session (since the `fo-idea` invocation). Capture the diff via `git diff <merge-base-of-session>...HEAD`. Wait for it to complete.
3. If the review has findings and no fix commit exists after the review report, invoke `fo-fix`. Wait for it to complete.

This fallback ensures review and fix are never skipped, even if `fo-idea-implement` failed to execute them internally.

#### ADR pipeline

ADRs skip audit, enhance, and plan — the pipeline is shorter.

**Step 1 — Implement (includes review and fix)**

Invoke `fo-idea-implement` on the ADR. Pass the ADR id. Wait for it to complete. `fo-idea-implement` now runs the full implementation → review → fix cycle internally:

- Transition to accepted, implement decision, run scoped build, ADR code-trace, update docs, stamp implemented + commit.
- Run `fo-review` on all session code changes.
- Run `fo-fix` if the review has findings.

Do not invoke `fo-review` or `fo-fix` separately — they are built into `fo-idea-implement`.

**Fallback verification (MANDATORY).** After `fo-idea-implement` returns, verify that review and fix were actually executed:

1. Check for a review report in `docs/reviews/code/` dated today or with a `diffRange` covering this session's commits.
2. If no review report exists, invoke `fo-review` with scope: all code changes made in this session. Wait for it to complete.
3. If the review has findings and no fix commit exists after the review report, invoke `fo-fix`. Wait for it to complete.

This fallback ensures review and fix are never skipped, even if `fo-idea-implement` failed to execute them internally.

### 2. Report and stop

After the pipeline is complete (or if it was interrupted and resumed), present a single summary:

```
## Pipeline Summary

### Document: <RFC-XXXX or ADR-XXXX>
### Type: <RFC | ADR>
### Steps completed:
  0. Idea — <done (created document) | skipped (existing document)>
  1. Audit — <done | skipped (ADR)>
  2. Enhance — <done | skipped (ADR)>
  3. Plan — <done | skipped (ADR)>
  4. Implement — <done (review: <verdict>, fix: <N> fixed | no findings) | not run (stopped at plan)>
### Status: <implemented | needs attention | planned (stopped at plan)>
```

If multiple documents were processed, present one summary block per document.

**Stop.** Do not invoke `/grilling` or any other skill after the pipeline is complete. The operator asked to "just see the result" — the result is the summary above.

### 3. Resume if interrupted

If the session was interrupted (agent stopped, context limit, crash, checkpoint summary) and the operator re-invokes this skill or continues the session:

1. **Detect pipeline context** — before doing anything else, determine whether this skill was the original invocation. Check for:
   - Checkpoint summary mentioning this skill or a TODO list with implementation steps for an RFC/ADR that was being processed by this pipeline.
   - TODO list with steps like "Step N: ..." or "implement: RFC-XXXX step N" — these are implementation steps from the plan phase, meaning the pipeline was in step 4 (implement).
   - Git log showing `audit:`, `enhance:`, `plan:`, `implement:` commits for the same RFC/ADR — confirming pipeline progress.
   - If any of these are found, this skill IS the active pipeline — resume it, do not start a new one.
2. **Detect progress** — check which pipeline steps have already been completed by scanning for:
   - Document exists in `docs/rfcs/` or `docs/adrs/` (idea creation done)
   - Audit report in `docs/audits/audit-rfc-XXXX-*.md`
   - `enhancedAt` in the RFC frontmatter
   - Plan file in `docs/plans/plan-rfc-XXXX-*.md`
   - `status: implemented` in the document frontmatter
   - Review report in `docs/reviews/code/**/*.md`
   - Fix commits in `git log --oneline` since the session started
3. **If `stopAfter: plan` and plan file exists** — stop immediately. Do not proceed to implement.
4. **Resume from the first incomplete step** — do not re-run completed steps.
5. **MANDATORY: Check for review and fix.** If `status: implemented` is set but NO review report exists in `docs/reviews/code/` for this session, the pipeline is NOT complete — resume at the review step (invoke `fo-review` then `fo-fix` if needed). This is the most common resume failure: implementation completes, stamp happens, but review/fix are skipped because the session was interrupted.
6. **Continue until the pipeline is complete** (or until `stopAfter` limit is reached) — then report and stop.

## Constraints

- **Pure orchestrator.** Delegate every step to the appropriate skill — this orchestrator does not implement code, write RFCs/ADRs, or run validation commands directly.
- **No pauses between pipeline steps.** The operator's invocation is the instruction to run the entire pipeline. Proceed automatically.
- **Interactive steps within skills.** Some skills (enhance, plan) have interactive sub-steps (grilling, resolving open questions). Those interactions happen inside the invoked skill.
- **Review and fix are inside implement.** `fo-idea-implement` runs `fo-review` and `fo-fix` internally. Do not invoke them as separate orchestrator steps.
- **Fallback verification is MANDATORY.** After `fo-idea-implement` returns, always check that a review report exists in `docs/reviews/code/` for this session. If missing, invoke `fo-review` and `fo-fix` as a fallback. This ensures review and fix are never skipped.
- **Commit only your own files** — see `_shared/fo-pipeline-conventions.md` §Commit discipline. Each invoked skill stages only its own files.
- Recoverable errors: see `_shared/fo-pipeline-conventions.md` §Recoverable errors.
- **Forward-only** — see `_shared/fo-pipeline-conventions.md` §Forward-only discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
