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

<!--
<MODULE_CONTRACT>
<purpose>fo-idea-i-just-want-to-see-the-result skill — Orchestrate the full feature pipeline (idea, audit, enhance, plan, implement, review, fix) in one invocation. Accepts a raw idea or RFC/ADR id. Use when the operator wants the complete pipeline.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — SKILL.md headers + classification fixes

Sweep batch 1: add Compass v2 headers to 45 SKILL.md files (purpose derived from frontmatter description). Fix non-skill-markdown exclusion to check filename not workspace-relative path (packages/AGENTS.md escaped it). Add .coverage to ignoredDirs.</item>
  <item>RFC-1140: step 5 — queue-mode section in orchestrator SKILL.md

Add Queue mode section (pre-flight queue.validate, loop semantics, failure handling, manifest immutability) to fo-idea-i-just-want-to-see-the-result SKILL.md, sync .agents copy, add forgeQueueModule row to forge AGENTS.md.</item>
  <item>RFC-1140: queue mode — materialize manifest at invocation from pasted doc list

When the invocation carries >=2 RFC/ADR ids without a manifest path, the orchestrator builds docs/queues/session-<timestamp>.yaml from the pasted order, runs queue.validate, then processes queue mode. Unresolvable ids are named explicitly.</item>
</CHANGE_SUMMARY>
-->

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
- **A queue manifest** — `--queue <path>` or a `docs/queues/*.yaml` path in the invocation text. The skill enters queue mode (see §Queue mode) and processes the manifest's `items[]` in order.
- **A pasted document list** — >=2 `RFC-XXXX`/`ADR-XXXX` ids in the invocation text (e.g. another agent's ordered implementation plan). The skill materializes a session manifest (see §Queue mode → Manifest materialization) and enters queue mode.
- **Nothing** — if neither is provided, check session context and IDE for a recently created document. If none found, ask the operator: "Какую идею реализуем? Опишите идею или укажите RFC-XXXX / ADR-XXXX."

## Queue mode

The orchestrator runs in **queue mode** when the invocation carries `--queue <path>`, a `docs/queues/*.yaml` path, OR a pasted document list (>=2 `RFC-XXXX`/`ADR-XXXX` ids — e.g. another agent's ordered implementation plan).

**Manifest materialization (mandatory when no manifest path is given):** Build the manifest from the invocation text before anything else:

1. Extract `RFC-\d{4}`/`ADR-\d{4}` tokens in order of appearance; dedupe preserving first-seen order. The pasted order IS the dependency order — preserve it even when the surrounding prose discusses a different grouping.
2. Write `docs/queues/session-<YYYYMMDD>-<HHmm>.yaml`:

   ```yaml
   id: session-<YYYYMMDD>-<HHmm>
   createdAt: <YYYY-MM-DD>
   items:
     - id: RFC-XXXX
     - id: ADR-XXXX
   ```

   The `id` field MUST equal the filename stem (`queue.validate` enforces this). Leave the file uncommitted — it is a session artifact; the operator may commit it for cross-session durability.

3. If the paste mixes ids with prose, ignore the prose — only the id sequence matters. Do not invent items that are not in the text.

**Pre-flight (mandatory):** Run `pnpm exec werkstatt run queue.validate --file <manifest> --json`. If the command exits non-zero (schema errors, unknown ids, duplicates, id↔filename mismatch), do NOT start the batch — report the errors and stop. When a pasted list references ids that do not resolve (QUEUE-04), name them explicitly — the operator must create those documents first or fix the list.

**Batch plan preview:** Emit the existing batch plan preview per `_shared/fo-pipeline-conventions.md` §Batch plan preview, listing items in manifest order.

**Loop semantics:** Process `items[]` in manifest order with no pauses between items:

1. **Skip terminal items** — items whose derived status is `implemented` or `skipped` (rejected/superseded frontmatter) are recorded in the batch summary and skipped.
2. **Resume mid-pipeline items** — an `in-progress` item resumes at its derived `pipelineStep`, not from step 1.
3. **Run the existing per-doc pipeline** — RFC items run audit → enhance → plan → implement; ADR items run implement only. All skill-internal interactions (grilling) stay inside the invoked skills.
4. **Batch-item checkpoint** — after each item, emit the context checkpoint per `_shared/fo-pipeline-conventions.md` §Context checkpoint between batch items.
5. **Clean-tree gate** — before starting the next item, verify the working tree has no uncommitted leftovers from the completed item; warn and stop if dirty.

**Failure:** If an item fails after its error checkpoint, stop the batch. The report names the blocked item id and the remaining item count. `blocked` is in-session report language only — never persist it into frontmatter, manifests, or files. Resume = re-invoke with the same manifest; `queue.validate` derives where to continue.

**Manifest immutability:** Do not edit `items[]` or the manifest during a queue run. Reordering requires stopping the batch and re-validating.

## Process

### 0. Idea creation (conditional)

Determine whether the operator provided a raw idea or a document id:

1. **Document id detected** — if the operator's input contains `RFC-XXXX` or `ADR-XXXX`, skip this step. Record the id and proceed to step 1.
2. **Session context** — look for the most recent `fo-idea` or `fo-idea-create-rfc` / `fo-idea-create-adr` invocation in the current session. If found, extract the document id(s) from its output and proceed to step 1.
3. **IDE context** — if a document file (`docs/rfcs/rfc-XXXX-*.md` or `docs/adrs/adr-XXXX-*.md`) is open in the IDE, use it and proceed to step 1.
4. **Raw idea** — if the operator provided natural-language text that is not a document id, invoke `fo-idea` with the idea text. Wait for it to complete (classify, grill, create RFC/ADR, commit). Extract the document id(s) from its output. Then proceed to step 1.
5. **Nothing** — ask the operator (in `aiLanguage`): "What idea should we implement? Describe the idea or specify RFC-XXXX / ADR-XXXX."

Record the document id(s) and type(s) (RFC or ADR). If multiple documents were created in a series, process them in dependency order — the same order `fo-idea` created them.

### 1. Pre-pipeline checkpoint

Before starting the pipeline, perform a pre-pipeline checkpoint per `_shared/fo-pipeline-conventions.md` §Pre-pipeline checkpoint. If pre-existing session context exists (discussion, document creation, debugging), emit the checkpoint block, release pre-existing context, and start the pipeline with a fresh read phase. If the session has no prior context, skip the checkpoint.

### 2. Run the pipeline

For each document, run the full pipeline inline. The pipeline differs for RFCs and ADRs.

**Between batch items:** After completing one document's pipeline and before starting the next, perform a context checkpoint per `_shared/fo-pipeline-conventions.md` §Context checkpoint between batch items. Emit the checkpoint block, release completed-item context, and start the next item with a fresh read phase. This does not pause for operator input — the checkpoint is an agent-internal context management step, not a user interaction.

**Batch plan preview:** When processing >=2 documents, emit a batch plan preview per `_shared/fo-pipeline-conventions.md` §Batch plan preview before starting the first document.

**Progress beacon:** After completing each pipeline step, emit a one-line progress beacon per `_shared/fo-pipeline-conventions.md` §Progress beacon. The beacon is informational — it does not pause the pipeline.

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

**Step-level checkpoints:** When implementing an RFC with >=5 plan steps, perform a step checkpoint after each plan step per `_shared/fo-pipeline-conventions.md` §Step-level context checkpoint during implementation. Emit the step-checkpoint block, release completed-step context, and start the next step with a fresh plan read.

**Error checkpoint:** If a pipeline step fails after 2 auto-fix attempts, emit a structured error checkpoint per `_shared/fo-pipeline-conventions.md` §Error checkpoint for pipeline step failures. Stop the pipeline and report to the operator.

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

### 3. Report and stop

After the pipeline is complete (or if it was interrupted and resumed), present a single summary in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only. Only identifiers (RFC-XXXX, ADR-XXXX, file paths) stay untranslated.

```
## <Pipeline Summary in aiLanguage>

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

### 4. Resume if interrupted

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
