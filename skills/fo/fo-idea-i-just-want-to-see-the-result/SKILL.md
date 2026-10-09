---
name: fo-idea-i-just-want-to-see-the-result
description: Orchestrate the full feature pipeline (idea, audit, enhance, plan, implement, review, fix) in one invocation. Accepts a raw idea or RFC/ADR id. Use when the operator wants the complete pipeline.
invocation: user
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["по полному пайплайну", "на результат", "реализуй RFC", "I just want to see the result", "implement this end-to-end without pauses"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-idea-i-just-want-to-see-the-result skill — Orchestrate the full feature pipeline (idea, audit, enhance, plan, implement, review, fix) in one invocation. Accepts a raw idea or RFC/ADR id. Use when the operator wants the complete pipeline.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1140: step 5 — queue-mode section in orchestrator SKILL.md

Add Queue mode section (pre-flight queue.validate, loop semantics, failure handling, manifest immutability) to fo-idea-i-just-want-to-see-the-result SKILL.md, sync .agents copy, add forgeQueueModule row to forge AGENTS.md.</item>
  <item>RFC-1140: queue mode — materialize manifest at invocation from pasted doc list

When the invocation carries >=2 RFC/ADR ids without a manifest path, the orchestrator builds docs/queues/session-<timestamp>.yaml from the pasted order, runs queue.validate, then processes queue mode. Unresolvable ids are named explicitly.</item>
  <item>RFC-1247: regen agents-generate golden fixture, add fo-handoff route row, PREFERENCES pipeline-intent caveat (RFC-1247)</item>
  <item>RFC-1250: review wave — QUEUE-07 gates un-parked opens only, ledger binding checks, fail-closed loader

REVIEW-RFC-1250-01 findings: QUEUE-07 no longer fires on parked entries
(the park is the containment — a parked queue stays resumable and the
decision window arbitrates it); loader fails open only on ENOENT —
other read errors are QUEUE-01; ledger gains queue/id-stem binding
(QUEUE-02), Q-N uniqueness (QUEUE-05), and QUEUE-08 hygiene warnings
(missing answers, foreign doc ids); next excludes QUEUE-07-blocked
items; top-level decision totals added. Orchestrator pre-flight treats
QUEUE-07 as the window agenda — structural errors still stop the batch;
maturation skips parked/deferred items; uncovered imperative ask sites
gain collect riders (ADR code-trace, NC markers, audit-verdict guard).</item>
  <item>RFC-1250: re-review wave — blocked dependsOn cascade, manifest-failure gating, generated artifacts</item>
  <history>RFC-1097, RFC-1250</history>
</CHANGE_SUMMARY>
-->

# Full Pipeline — Just Want to See the Result

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

See `_shared/fo-pipeline-conventions.md` §Language policy.

This skill is a **pure orchestrator** — it delegates every step to the appropriate skill.

## stopAfter contract

This orchestrator supports a `stopAfter` parameter that limits how far the pipeline runs:

- **`stopAfter: plan`** — run phases 1–3 of the queue model (maturation, decision window, resolution; see §Queue mode — the four-phase model). Do not run execution (implement, which includes review and fix). After resolution completes, report the summary and stop.
- **`stopAfter: null` (default)** — run the full pipeline through implement (which includes review and fix).

When `stopAfter: plan` is set and the document is an **ADR**, the ADR pipeline skips audit/enhance/plan — it contributes no maturation questions and joins the decision window only if ledger entries exist for it. Stop after the resolution phase with the message: "ADR does not require a plan. Re-invoke `/fo-idea-i-just-want-to-see-the-result` with the same manifest to execute."

When resuming with `stopAfter: plan`, if the plan file already exists in `docs/plans/plan-rfc-XXXX-*.md` and carries no `PENDING DECISION` markers, stop immediately — do not proceed to execution.

## Preconditions

### Intent routing (front door)

This skill is the operator's single front door. Before document-id detection, classify the invocation — not every first message is a pipeline request:

| Intent signal (examples) | Route |
| --- | --- |
| RFC/ADR ids, queue manifest, plan list, «реализуй», «по полному пайплайну», «на результат» | the existing pipeline flow below (unchanged) |
| «проверим всё ли сделали», «проверь изменения», "review this session" | `fo-review` → optional `fo-fix`; do not enter implement |
| «исправим», "fix all", persisted review findings | `fo-fix`; do not enter implement |
| Session-end phrases («завершаем сессию», «протокол завершения») | `fo-session-retro` contract — never a pipeline |
| Commit intent («закоммитим», "commit this", staged-step commit requests) | `fo-step-commit` |
| Handoff intent ("create a handoff", "compact conversation", "prepare handoff") | `fo-handoff` |
| Open-mission / Sternsystem work («работаем над миссией», `wg-*` names) | the named `wg-*` skill |
| «нам надо закрыть открытые вопросы», exploratory ideas | `fo-explore` or `fo-idea` (existing step 0) |
| Ambiguous | ask the operator — never default to implement on ambiguity |

**Misroute guard:** once classified as a non-pipeline intent, do NOT silently re-enter the pipeline; if the routed skill's output reveals the request was actually a pipeline intent, surface that in the report instead. Phrase collisions resolve by intent described, not single-word match — a collision that cannot be resolved asks the operator, never guesses into a mutating skill.

### Accepted inputs

The operator may provide either:

- **A raw idea** — natural-language description of a feature, change, or decision. The skill will invoke `fo-idea` as step 0 to create the RFC/ADR first.
- **An existing RFC/ADR id** — e.g. `RFC-XXXX` or `ADR-XXXX`. The skill skips idea creation and starts the pipeline from the appropriate step.
- **A queue manifest** — `--queue <path>` or a `docs/queues/*.yaml` path in the invocation text. The skill loads it as the run's manifest (see §Queue mode — the four-phase model) and processes the manifest's `items[]` in order.
- **A pasted document list** — >=2 `RFC-XXXX`/`ADR-XXXX` ids in the invocation text (e.g. another agent's ordered implementation plan). The skill materializes a session manifest (see §Queue mode → Manifest materialization).
- **A single document id** — materializes a one-item manifest; the same four-phase model applies (the decision window still fires, usually small).
- **Nothing** — if neither is provided, check session context and IDE for a recently created document. If none found, ask the operator: "Какую идею реализуем? Опишите идею или укажите RFC-XXXX / ADR-XXXX."

## Queue mode — the four-phase model

**Every orchestrator run is a queue run.** The invocation carrying `--queue <path>`, a `docs/queues/*.yaml` path, a pasted document list, or a single `RFC-XXXX`/`ADR-XXXX` id all enter the same four-phase model; a single document materializes a one-item manifest. There is exactly one execution model — operator decisions are front-loaded into a single decision window, then execution runs uninterrupted.

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

**Decision ledger:** the queue owns `docs/queues/<id>.decisions.yaml` — the durable, append-only record of every operator-facing decision (`_shared/fo-pipeline-conventions.md` §Decision ledger). Create it when maturation emits its first question. The rendered `docs/queues/<id>.briefing.md` is generated from the ledger for the decision window.

**Pre-flight (mandatory):** Run `pnpm exec werkstatt run queue.validate --file <manifest> --json`. Interpret diagnostics by kind:

- **Structural errors** (QUEUE-01..06 — schema, unknown ids, duplicates, id↔filename mismatches, ledger load/binding failures) — do NOT start the batch; report the errors and stop. When a pasted list references ids that do not resolve (QUEUE-04), name them explicitly — the operator must create those documents first or fix the list.
- **QUEUE-07 diagnostics** — implementable items carrying un-parked `open` decisions. This is NOT a stop signal: those entries are precisely the decision window's agenda. The run proceeds — phase 1 finishes any incomplete maturation, then phase 2 arbitrates them. This is the designed resume path after a crash between collect and window, and after runs that parked items for arbitration.
- **QUEUE-08 warnings** — ledger hygiene (resolved entries missing `answer`, decisions targeting foreign doc ids); report them in the batch summary, continue.

Re-run `queue.validate` between resolution and execution: items still carrying un-parked `open` entries after the window are excluded from `next`, skipped by execution, and listed in the report — never implemented.

**Batch plan preview:** Emit the existing batch plan preview per `_shared/fo-pipeline-conventions.md` §Batch plan preview, listing items in manifest order.

### Phase 1 — Maturation (no operator)

Process `items[]` in manifest order. Per item, run the existing per-doc pipeline up to but not including implementation, with every skill in **collect mode** (`_shared/fo-pipeline-conventions.md` §Collect and finalize contract):

1. **Skip terminal and parked items** — items whose derived status is `implemented` or `skipped` (rejected/superseded frontmatter), and items parked by `deferred` entries or `open`+`parked: true` entries (plus their `dependsOn` dependents) are recorded in the batch summary and skipped — maturation never re-collects questions for a parked item.
2. **Resume mid-pipeline items** — an `in-progress` item resumes at its derived `pipelineStep`, not from step 1.
3. **Run the collect-mode pipeline** — RFC items run audit → enhance(collect) → plan(collect); ADR items skip maturation stages. Questions emit into the ledger as `open` entries carrying `resolutionPath` and recommended options; autonomous work applies and commits; `enhancedAt` stamps only when zero `open` entries remain for the document; the plan persists as a draft carrying `> PENDING DECISION: Q-N` markers. No `ask_user_question` calls inside any pipeline step — every question materializes in the ledger first.
4. **Batch-item checkpoint** — after each item, emit the context checkpoint per `_shared/fo-pipeline-conventions.md` §Context checkpoint between batch items.
5. **Clean-tree gate** — before starting the next item, verify the working tree has no uncommitted leftovers from the completed item; warn and stop if dirty.

### Phase 2 — Decision window (the single operator interaction)

Render `docs/queues/<id>.briefing.md` from the ledger per `_shared/fo-pipeline-conventions.md` §Decision window and present it: batch policies, per-document decision blocks with recommended options, the resolved-by-inference list, and the parked-items section — every `open`+`parked: true` entry is arbitration the operator owes here. The operator answers in one batch — free-text codes (`Q-03: B`, `all — per recommendations`, `Q-07: defer`); `ask_user_question` is legal only for ≤4 highest-risk decisions. The answered window IS the batch acceptance act.

### Phase 3 — Resolution (no operator)

Apply answers to the ledger (`status: answered`, `answeredAt`), then finalize each document in manifest order: integrate answers into the RFC/plan body, lift `PENDING DECISION` markers, stamp `enhancedAt` where pending, and commit the `draft → accepted` transition per document (`fo-idea-plan` owns the transition mechanics). One bounded follow-up window is permitted only when an answer invalidates a drafted plan and surfaces a genuinely new trade-off — then proceed.

### Phase 4 — Execution (no operator)

Process items in manifest order — RFC items run `implement` (which includes review → fix), ADR items run `implement` only:

1. **Skip terminal, parked, and blocked items** — `implemented`/`skipped`, items with `deferred` ledger entries or `open`+`parked: true` entries, QUEUE-07-blocked items (un-parked `open` entries surviving the window), and items whose `dependsOn` target is parked or QUEUE-07-blocked. `queue.validate`'s `next` encodes the same skipping.
2. **Ledger-bound implementation** — `fo-idea-implement` reads the ledger at prerequisites: `answered` entries bind; emergent questions auto-resolve and append `auto-resolved` entries; only the enumerated hard-stop class parks the item (§Auto-resolve and log).
3. **Batch-item checkpoint** — after each item, emit the context checkpoint; **clean-tree gate** before the next item.
4. **`stopAfter: plan`** — run phases 1–3 (maturation + window + resolution), stop before execution.

**Failure:** If an item fails after its error checkpoint, stop the batch. The report names the blocked item id and the remaining item count. `blocked` is in-session report language only — never persist it into frontmatter, manifests, or files. Resume = re-invoke with the same manifest; `queue.validate` derives where to continue and the ledger carries answered decisions across sessions.

**Blocking review verdicts:** when a review inside an item's pipeline returns a blocking verdict —

- `blockLevel: soft-block` — **pause only the current item**: record it in the batch summary as `awaiting operator arbitration`, append the arbitration question to the ledger (`status: open`, `stage: review`, `parked: true` — the system parked it, so QUEUE-07 treats it as contained rather than a gate violation), then continue with the next item. Never auto-resolve an arbitration question. A parked item resumes by re-invoking the orchestrator with the same manifest — parking never strands an item without a defined re-entry path.
- `blockLevel: hard-block` — **stop the item before stamping and record it as blocked in the batch report; the batch continues.** A parked hard-block item requires the fix and then a **full** re-review on resume (not a delta re-check); at most two fix→re-review cycles, then the hard-stop class escalates the item for arbitration (§Auto-resolve and log).
- The batch summary MUST list every paused/blocked item with its ledger question ids — accumulation is visible, never silent.

**Manifest immutability:** Do not edit `items[]` or the manifest during a queue run. The ledger — not the manifest — carries decision state. Reordering requires stopping the batch and re-validating.

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

For each document, run the full pipeline inline — under the four-phase queue model (§Queue mode), per-document steps run in collect/finalize phases. The pipeline differs for RFCs and ADRs.

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
- **No inline questions inside orchestrated steps.** Under the four-phase model, pipeline steps run in collect mode — every operator-facing question materializes in the queue's decision ledger (`_shared/fo-pipeline-conventions.md` §Collect and finalize contract), and the single decision window is the only scheduled interaction. Standalone skill invocations keep interview behavior.
- **Review and fix are inside implement.** `fo-idea-implement` runs `fo-review` and `fo-fix` internally. Do not invoke them as separate orchestrator steps.
- **Fallback verification is MANDATORY.** After `fo-idea-implement` returns, always check that a review report exists in `docs/reviews/code/` for this session. If missing, invoke `fo-review` and `fo-fix` as a fallback. This ensures review and fix are never skipped.
- **Commit only your own files** — see `_shared/fo-pipeline-conventions.md` §Commit discipline. Each invoked skill stages only its own files.
- Recoverable errors: see `_shared/fo-pipeline-conventions.md` §Recoverable errors.
- **Forward-only** — see `_shared/fo-pipeline-conventions.md` §Forward-only discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
