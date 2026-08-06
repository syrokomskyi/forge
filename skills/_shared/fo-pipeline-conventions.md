# WG Pipeline Shared Conventions

Reference file for all `fo-*` skills. Each skill links to the sections it needs via context pointers like "Read `_shared/fo-pipeline-conventions.md` §Recoverable errors".

## PREFERENCES

Read `PREFERENCES.md` at the repository root before starting. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

## Language policy

- Every natural-language message shown to the operator — greetings, questions, explanations, summaries, status updates — must use `aiLanguage`.
- Generated documentation, commit messages, and persisted artifacts must use `documentationLanguage`.
- Internal reasoning, tool-call planning, and intermediate agent monologue may stay in the agent's working language (usually English).
- Do not translate existing files automatically; preferences affect only new output and the current session.
- **Report and summary templates in skill definitions are structural examples only.** All labels, headings, table headers, column names, and descriptions in operator-facing output must be translated to `aiLanguage`. Only identifiers (RFC-XXXX, ADR-XXXX, file paths, slash commands, CLI flags) stay in their original form. Do not copy English template labels verbatim into the operator-facing output.

## Recoverable errors

No pauses for recoverable tool errors. If a tool call fails with a recoverable error — `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — recover autonomously: split content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".

## Commit discipline

Stage only the files this skill produces or modifies. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

## Pipeline reference

- **RFC pipeline**: create → audit → enhance → plan → implement (includes review → fix)
- **ADR pipeline**: create → implement (includes review → fix)

## Minimality ladder

Before writing implementation code, climb the minimality ladder. Stop at the first rung that holds — that is your implementation. The ladder runs after you understand the problem (read the code, trace the flow), not instead of it.

1. **Does this need to exist?** → no: skip it (YAGNI)
2. **Already in this codebase?** → reuse it, don't rewrite
3. **Stdlib does it?** → use it
4. **Native platform feature?** → use it (e.g. `<input type="date">` instead of a date picker library)
5. **Installed dependency?** → use it
6. **One line?** → one line
7. **Only then**: write the minimum that works

Lazy about the solution, never about reading. Lazy, not negligent: trust-boundary validation, data-loss handling, security, and accessibility are never on the chopping block — they are part of "the minimum that works."

The ladder is a pre-coding decision tool, not a post-hoc review checklist. It determines the implementation approach before the first edit. During `fo-review`, the reviewer checks whether the author climbed the ladder — flagging cases where a library was installed for something stdlib/native/existing-dep already provides.

## Forward-only discipline

The ecosystem is forward-only. No backward compatibility layers, no shims, no dual-paths. Legacy code paths are deleted, not maintained behind a flag. Deprecation means removal in the same change, not an indefinite grace period.

## Compass terminology

Use Compass (not GRACE) in all new code, documentation, and log messages.

## Compass scaffolding

Non-trivial new source files in `apps/` or `packages/` must carry `MODULE_CONTRACT` and `CHANGE_SUMMARY` scaffolding. Check the project's invariants file for the canonical Compass markup rule.

## Build verification discipline

MUST NOT run root `root build` or `turbo run build` — these build every workspace and are prohibitively expensive for iterative workflows. Run scoped checks only: `astro check` for touched apps, `tsc --noEmit` (via `build:check`) for touched packages. See root AGENTS.md §Build verification discipline.

## Command execution timeout discipline

Every `run_command` call MUST use a 6-minute (360 000 ms) execution budget. This prevents the agent from blocking on hung or excessively long commands.

### Rules

1. **Always non-blocking**: Call `run_command` with `Blocking: false` and `WaitMsBeforeAsync: 360000` (6 min). This lets the agent regain control if the command hasn't finished.
2. **Check status**: After `WaitMsBeforeAsync` elapses, call `command_status` with `WaitDurationSeconds: 0` to see if the command completed.
3. **If completed**: Read the output and proceed normally.
4. **If still running after 6 min**: Abandon the command — do not wait further. Try an alternative approach (different command, different scope, or skip the step). If no alternative exists, retry the same command once with the same 6-min budget.
5. **Max retries**: 2 attempts per command. After 2 failed attempts, report to the operator and ask how to proceed.
6. **No infinite waits**: NEVER call `command_status` with `WaitDurationSeconds` > 60. NEVER use `Blocking: true` for commands that may hang (builds, checks, `site-kernel run`, `astro check`, `tsc`, `pnpm install`).
7. **Exceptions**: `Blocking: true` is allowed only for trivially fast commands (e.g., `node --version`, `git log -n 1`, `git status --short`) that are guaranteed to complete in seconds.

### Rationale

- The `run_command` tool has no built-in timeout parameter. `WaitMsBeforeAsync` is the only mechanism to regain control after a fixed duration.
- Abandoning a still-running process is acceptable — the process may complete in the background, but the agent is unblocked and can retry or try an alternative.
- This covers all command classes: `pnpm exec site-kernel run ...`, `pnpm --filter <pkg> run build:check`, `astro check`, `git`, `pnpm install`, etc.
- Site-kernel commands already have internal `timeoutMs`, but the agent-side 6-min budget is a safety net for ALL commands, not just site-kernel.

## Binding resolution and degradation

### How to resolve bindings

Skills reference bindings by key, never by value. To resolve a binding:

1. Read `forge.yaml` at the project root.
2. Navigate to the `bindings` section.
3. Resolve the key (e.g. `commands.validateRfc`) to its value.
4. If the value contains placeholders (`{id}`, `{workspace}`, `{file}`), substitute them with the actual values for the current operation.
5. If the binding is `null` or the `bindings` section is absent, the capability is absent.

### Binding keys

| Key                     | Type                   | Description                            |
| ----------------------- | ---------------------- | -------------------------------------- |
| `commands.validateRfc`  | string \| null         | Command to validate an RFC             |
| `commands.validateAdr`  | string \| null         | Command to validate an ADR             |
| `commands.typecheck`    | string \| null         | Scoped typecheck command               |
| `commands.test`         | string \| null         | Scoped test command                    |
| `commands.scopedBuild`  | string \| null         | Scoped build command                   |
| `commands.specValidate` | string \| null         | Spec validation command                |
| `paths.invariantsFile`  | string \| null         | Path to the project's invariants file  |
| `paths.compassDocs`     | string[]               | Machine-readable semantic docs to sync |
| `paths.reviewsDir`      | string \| null         | Directory for code reviews             |
| `paths.handoffsDir`     | string \| null         | Directory for handoff documents        |
| `terminology`           | Record<string, string> | Project-specific terminology mapping   |

### Degradation contract

- **Required binding unresolvable** (missing or `null`): the skill refuses to start with: `Skill <name> requires binding <key>; add it to forge.yaml or mark the capability absent deliberately.`
- **Optional binding absent** (`null` / empty): the dependent step is skipped and the skill's final report MUST contain a `Degraded:` line naming each skipped capability.
- **Silent skips are a contract violation.** Every skipped capability must appear in the final report.

### Worked example

A skill needs to run `rfc.validate` for `RFC-XXXX`:

1. Read `forge.yaml` → `bindings.commands.validateRfc` = `"pnpm exec site-kernel run rfc.validate {id} --json"`
2. Substitute `{id}` → `"pnpm exec site-kernel run rfc.validate RFC-XXXX --json"`
3. Run the resolved command.

If `bindings.commands.validateRfc` were `null`, the skill would skip the step and report: `Degraded: commands.validateRfc — not configured in forge.yaml`.

## Session-end sequence

After completing implementation work, the operator may run a three-step session-end sequence. These are **operator-invoked**, never automatic:

1. **`fo-doc-audit`** — are existing docs in sync with code changes? (mechanical check)
2. **`fo-session-retro`** — did the session produce insights worth routing to a durable home? (reflective triage)
3. **`fo-handoff`** — what does the next agent need? (continuity document)

Most sessions need only `fo-doc-audit`. `fo-session-retro` is valuable after debugging sessions, exploratory work, or when non-obvious behaviors were discovered. `fo-handoff` is needed when work is incomplete and another agent will continue.

### Session-end trigger phrases (BLOCKED GATE — NON-NEGOTIABLE)

When the operator says any session-end trigger phrase (e.g. "Завершаем сессию", "Завершаем эту сессию", "Заканчиваем сессию", "Завершить сессию", "End session", "Wrap up", "Session end", "/session-end"), the agent's response is **BLOCKED** — no closing summary, no ad-hoc "session complete" message, no closing block is permitted until `fo-session-retro` is invoked via the `skill` tool and completes.

**The agent MUST NOT produce any session-end output (summary, closing block, "session complete" message) before `fo-session-retro` is invoked and its report is presented. Producing a closing summary without running `fo-session-retro` is a CONTRACT VIOLATION.**

The `fo-session-retro` skill IS the session-end protocol — it runs transcript save, temp cleanup, docs.archive, clean tree check, RFC verification, insight triage, and produces the closing block. Do not substitute it with a manual summary. The closing block comes from `fo-session-retro`, not from the agent directly.

## Context checkpoint between batch items

When the orchestrator skill processes multiple documents (>=2), perform a context checkpoint after completing one document and before starting the next:

1. **Emit checkpoint block** — output a YAML-formatted block in conversation output with the following fields:
   - `completed`: RFC/ADR id of the completed document
   - `status`: final status (implemented, accepted, draft, failed)
   - `commits`: list of commit SHAs produced for this document
   - `lessons`: 1-3 short freeform sentences capturing key errors, root causes, patterns discovered, or validator quirks encountered during this document's pipeline run
   - `dependencies`: cross-RFC dependency notes (e.g., "RFC-YYYY depends on RFC-XXXX for schema field Z") — empty if none
   - `next`: id of the next document to process, or `null` if this was the last
2. **Release context** — explicitly treat all detailed context from the completed document as no longer actionable: file contents, search results, edit operations, intermediate reasoning. Retain only the checkpoint block. Release means treat as no longer actionable for reasoning, not delete or undo.
3. **Fresh start** — begin the next document with a fresh read phase: re-read the RFC file and all related documents (amends, supersedes, related RFCs, DNA invariants, AGENTS.md sections).

The checkpoint block doubles as a resume marker: when resuming an interrupted batch, scan conversation output for the last checkpoint block, extract completed ids and statuses, and continue with the next uncompleted item. If no checkpoint markers are found, fall back to the existing resume logic (git log, file inspection, frontmatter status).

**Only applies to batch processing (>=2 documents).** Single-document invocations do not need a checkpoint — the context is already fresh at the start.

## Step-level context checkpoint during implementation

When the orchestrator skill implements a single RFC with >=5 plan steps, perform a step checkpoint after completing each plan step and committing:

1. **Emit step-checkpoint block** — output a YAML-formatted block in conversation output with the following fields:
   - `rfc`: RFC id being implemented
   - `step`: plan step number (e.g., 3)
   - `title`: plan step title
   - `commit`: SHA of the commit produced by this step
   - `decisions`: 1-3 short freeform sentences capturing key micro-decisions made during this step (e.g., "used flag instead of new command", "skipped validator X because it's in package Y, not in scope")
   - `errors`: list of errors encountered and fixed during this step — empty if none
   - `nextStep`: number of the next plan step, or `null` if this was the last
2. **Release step context** — treat all detailed context from the completed step as no longer actionable: codebase search results, file reads, edit operations, validation output. Retain only the step-checkpoint block and the RFC's plan file.
3. **Fresh start** — begin the next plan step with a fresh read of the plan file and the specific files the next step touches.

The step checkpoint doubles as a resume marker: when resuming an interrupted implementation, scan conversation output for the last step-checkpoint block, extract the completed step number, and resume from the next step.

**Only applies to plans with >=5 steps.** Small plans (4 or fewer steps) do not need step checkpoints — the context is manageable without them.

## Progress beacon

The orchestrator skill emits a one-line progress beacon after completing each pipeline step (audit, enhance, plan, implement, review, fix) for each RFC. The beacon is informational only — it does not pause the pipeline, does not request operator input, and does not release context.

Format: `[beacon] RFC-XXXX | <step> ✓ | next: <next-step>`

For failed steps being fixed: `[beacon] RFC-XXXX | <step> ✗ (fixing...) | next: <next-step>`

The beacon text must use `aiLanguage` per the language policy.

## Error checkpoint for pipeline step failures

When a pipeline step fails and cannot be auto-fixed within 2 attempts (per §Command execution timeout discipline), emit a structured error checkpoint block in conversation output:

1. **Emit error checkpoint** — output a YAML block with: rfc, step, planStep (if within implement phase), error (command, exitCode, summary, attempts), partialState (filesModified, commits, rfcStatus), resumePoint.
2. **Stop the pipeline** — do not continue to the next pipeline step. The error is not auto-fixable; continuing would compound the problem. This is an **explicit exception** to the orchestrator's "no pauses between pipeline steps" constraint. The "no pauses" directive assumes the pipeline can proceed; when an error is unfixable after 2 attempts, continuing is impossible and the exception is justified. The pause is for error reporting, not for optional operator input.
3. **Report to operator** — present the error checkpoint in `aiLanguage` and ask the operator how to proceed: fix manually, skip the step, or abort the RFC.

The error checkpoint doubles as a resume marker: when resuming an interrupted session, scan for the last error checkpoint. If found, resume from the failed step using the partialState and resumePoint fields.

## Batch plan preview

When the orchestrator skill processes multiple documents (>=2), emit a batch plan preview before starting the first document. The preview is a table showing: processing order, document id, type, complexity estimate, dependencies, and notes.

The preview is informational — it does not pause for operator approval unless the operator explicitly requests confirmation. The operator's invocation of the orchestrator is the instruction to proceed.

The preview text must use `aiLanguage` per the language policy.
