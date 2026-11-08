---
name: fo-system-dispatch
description: Run a task end to end inside a system repository — read the queue, scan product outboxes, write self-contained briefs, move tasks to ready, dispatch, and collect reports.
invocation: user
category: fo
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["dispatch a system task", "run the system queue", "move a task to ready and dispatch it"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-system-dispatch skill — drive one task through the system queue: status → brief → ready → dispatch → collect, asking the operator only for a parked task or a needs-decision report.</purpose>
<non-goals>
  <item>Do not work in a product repository — the system agent reads queues and writes briefs, never product code.</item>
</non-goals>
</MODULE_CONTRACT>
-->

# fo-system-dispatch

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Use this skill inside a **system repository** — the one holding `system/system.yaml`. A system session never opens a product checkout; the product's own session does the work.

## Steps

### 1. Read the queue

Run `system.task.status`. It joins every task file with its product-side registry and journal evidence — one picture per task: state, branch, and what the product last reported.

### 2. Create tasks

Operator-initiated work starts as `system.task.create --product <p> --slug <s> --title <t> --kind <adoption|change|…>` — including the adoption tasks the operator's runbook hands this skill. Then run `system.outbox.scan` (add `--create` to materialize matched entries as `proposed` tasks). A scan is read-only without `--create`; unmatched, forbidden or unresolvable entries surface as SYSTEM-OUTBOX diagnostics (schema-invalid entries as OUTBOX-01/02), never silent drops.

### 3. Write a self-contained brief

For each `proposed` task you intend to dispatch, write `queue/briefs/<id>.md` so that a session which has never seen this repository can do the work. Frontmatter carries `schema: forge/dispatch-brief@1`, the task id, the product, a non-placeholder `goal`, and at least one `acceptance: [{claim, check}]` — all gated by the ready move. The body carries what to change, where to look, and how the session proves it. A brief that needs system context to parse is a failed brief.

### 4. Move to `ready`

Run `system.task.move --task <id> --to ready`. The ready gate checks the brief exists, binds to the task, and clears dependency and edge rules — fix what it reports instead of retrying.

### 5. Dispatch

Run `system.task.dispatch --task <id>`. Dispatch opens a task worktree inside the product checkout, plants `.forge/task/brief.md` there, and prints the worktree path to `cd` into — start that session yourself or hand the printed command to the operator. When `products.local.yaml` declares `launcher.argv`, the product session is invoked automatically.

A dispatch refusal is information: read the SYSTEM-TASK or FLOW-OPEN diagnostic, repair the cause (unmapped folder, forbidden edge, wedged flow), then dispatch again.

### 6. Collect

Later, run `system.task.collect --task <id>` after the product session reports. Collect maps the outcome: `done` → `integrated` (with the journal's integrate evidence), `needs-decision` → `reported`, `blocked` → `failed`. A `needs-decision` report's question goes to the operator verbatim — then follow through with `system.task.move`: `reported → ready` (with `--reason`) before re-dispatching, `failed → ready` directly, or `ready`/`failed → parked` (with `--reason`) to shelve.

A dispatched task with no report stays `dispatched` — `--mark-failed --reason "<why>"` is the operator's call after a session dies, not a cleanup habit.

### 7. Commit queue files in this repository

Task files, briefs and collected reports live under `queue/` in the system repository — commit them through this repository's own governed session path, never through a product.

## Rules

- **Never commit or integrate inside a product checkout.** Integration is the product session's own governed step.
- **A `needs-decision` report becomes one operator question** — relay it verbatim, do not answer it yourself.
- **Briefs are the whole contract.** If a brief would not let a cold session finish the task, rewrite the brief before dispatching.
- **Task state changes only through `system.task.move`, dispatch, and collect** — free text goes into the brief or the report, never into `history` (F-0141).
