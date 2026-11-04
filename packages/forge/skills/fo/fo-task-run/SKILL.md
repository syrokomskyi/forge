---
name: fo-task-run
description: Execute a dispatched task inside a product worktree — read the planted brief, do the work with this repository's own gate, write the task report, then integrate.
invocation: user
category: fo
concerns: code-mutation
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["run this task in the product", "execute the planted brief", "work this dispatched task"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-task-run skill — take a dispatched task from .forge/task/brief.md to .forge/task/report.yaml inside the product worktree, finishing with the product's own integrate step.</purpose>
<non-goals>
  <item>Do not look for or touch the repository that sent the brief — the product session knows only its own worktree.</item>
</non-goals>
</MODULE_CONTRACT>
-->

# fo-task-run

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Use this skill inside a **product worktree** that was opened for a task — it carries `.forge/task/brief.md` at its root. The brief is the whole contract: a session that needs outside context to parse it should stop and report `blocked`.

## Steps

### 1. Read the brief

Read `.forge/task/brief.md`. It names the task id, the product, what to change, and how the change is proven. Work only inside this worktree — the product's primary checkout stays untouched.

### 2. Do the work

Use this repository's own skills, conventions and commit path. The brief names its acceptance intent; translate it into the repository's own evidence — tests, validators, probes.

Record a new dependency need — a contract another product may offer — through `fo-outbox` as an ordinary tracked entry; never hardcode a provider.

### 3. Run the product's gate

Run the repository's own gate exactly as a human would before integrating. Evidence lives in this repository — do not invent a parallel one.

### 4. Write the report

Write `.forge/task/report.yaml`:

```yaml
schema: forge/task-report@1
task: T-NNNN
outcome: done | blocked | needs-decision
summary: <one paragraph: what happened>
commits: [<full hashes this work produced>]
gate: pass | fail | not-run
acceptance:
  - claim: <what the brief asked>
    evidence: <how it is proven>
outbox: [<entry ids this work served, if any>]
```

- `outcome: done` goes with `gate: pass` — a report claiming done on a failing gate is dishonest, and collect will surface it to the operator.
- `outcome: needs-decision` requires `question:` — one question for the operator, verbatim-quotable.
- `gate: not-run` is honest when nothing ran; pair it with `blocked`, not `done`.

### 5. Integrate or stop

- Gate passed and report written → run this repository's `flow.integrate`. The task files survive teardown — the system collects them later.
- Gate cannot pass after two honest attempts → write `outcome: blocked`, leave the worktree as evidence, stop. Do not retry forever and do not merge anything yourself.
- The brief cannot be satisfied as written → `outcome: needs-decision` with the question.

## Rules

- **Integration stays the product's own `flow.integrate`** — nothing pushes, nothing merges behind the operator's back.
- **`.forge/task/` is scratch the worktree owns** — brief in, report out; do not commit it into the product's tracked tree.
- **Report honestly.** `blocked` is a first-class outcome; a wedged report helps nobody.
