# ADR Implementation Flow

Execute this flow when the document is an ADR (prefix `ADR-`, or file in `docs/adrs/`).

## 4.1. Read the ADR

Read the ADR file. Extract:

- **Status** — must be `accepted`, `reviewing`, or `proposed`. If `superseded` or `rejected` (terminal), stop with message: `ADR-XXXX is <status> (terminal). Terminal ADRs cannot be implemented. To change this decision, create a new ADR or RFC that supersedes ADR-XXXX.` If `implemented`, stop with message: `ADR-XXXX is already implemented. Nothing to do.`
- **Decision** — the core decision from the `## Decision` section.
- **Context** — the local situation and constraints from `## Context`.
- **Consequences** — what the decision implies for the codebase.
- **Related** — any RFCs, ADRs, or DNA invariants referenced.

## 4.2. Transition to accepted (if needed)

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

## 4.3. Implement the decision

Read the `## Decision` section and implement it in code. Follow the same principles as RFC implementation:

- Make autonomous, ecosystem-aligned decisions.
- Use `edit`/`multi_edit` for changes to existing files, `write_to_file` for new files.
- Commit each logical phase of work:

  ```txt
  implement: ADR-XXXX — <phase description>

  <one-line description of what was done in this phase>.
  ```

  Stage only the files touched by this phase — see `_shared/fo-pipeline-conventions.md` §Commit discipline.

- Recoverable errors: see `_shared/fo-pipeline-conventions.md` §Recoverable errors.

## 4.4. Run scoped build checks

After implementation is complete, run heavy checks for the impacted workspaces only:

1. ADR validation:

   ```sh
   pnpm exec werkstatt run adr.validate <adr-id> --json
   ```

2. Determine impacted packages/apps from the ADR's `scope` and the files touched during implementation. Build only those workspaces:

   ```sh
   pnpm --filter @gogol/<package> run build:check
   ```

   Or for apps:

   ```sh
   pnpm --filter <app-name> run build:check
   ```

   See `_shared/fo-pipeline-conventions.md` §Build verification discipline.

## 4.5. Fix errors

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

## 4.6. Documentation audit (fo-doc-audit)

After implementation is complete and all checks pass, invoke `fo-doc-audit` via the `skill` tool. It analyzes the session's changes, checks all documentation surfaces, applies needed updates, and commits them separately. Wait for it to complete.

If `fo-doc-audit` reports that no updates are needed, proceed to the next step.

## 4.7. ADR code-trace

Before stamping `implemented`, verify that the ADR is mentioned in the codebase — this leaves a trace linking code back to the decision record, just as RFCs leave traces.

1. **Search for the ADR id** — use `grep_search` to scan `apps/`, `packages/`, and `services/` for the ADR id string (e.g. `ADR-0003`). Check:
   - **COMPASS block comments** — `MODULE_CONTRACT`, `CHANGE_SUMMARY`, or other Compass scaffolding comments that reference the ADR id.
   - **Inline code mentions** — comments, docstrings, or annotations in source files that reference the ADR id.

2. **If mentions are found** — the trace exists. Proceed to step 4.8.

3. **If no mentions are found** — attempt to find the most relevant file(s) where the decision was implemented. If the file(s) can be identified:
   - Add a Compass block comment referencing the ADR id to the file's `MODULE_CONTRACT` or `CHANGE_SUMMARY` section. For example: `<item>ADR-0003: <brief note on what this ADR decided for this module.</item>`
   - If the file has no Compass scaffolding, add a brief inline comment at the top of the file: `// Implements ADR-XXXX: <one-line decision summary>`
   - Commit the trace:

     ```txt
     trace: ADR-XXXX — add code mention

     Add ADR-XXXX reference to <file> to link the decision to the code.
     ```

   - Proceed to step 4.8.

4. **If the relevant file(s) cannot be identified** — ask the operator: `ADR-XXXX was implemented but no code mention was found. Please point to the file(s) where this ADR's decision was applied so I can add a trace reference.` After the operator provides the file(s), add the trace as described in step 3, commit, and proceed.

**For already-implemented ADRs** (if this step is reached for an ADR that was already `implemented`): this check is informational — attempt to find the trace and add it if missing, but do not block on it.

## 4.8. Stamp implemented

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

## 4.9. Review (fo-review) — MANDATORY GATE

**This step is unconditional.** It MUST be executed after every implementation run — regardless of whether build checks passed, failed, or were fixed. No exceptions. The ADR report (step 4.11) MUST NOT be emitted until this step is complete.

1. **Determine the diff scope** — identify the git fixed point at the start of this implementation session (the commit before the first `implement:` or `adr:` commit). Capture the diff via `git diff <fixed-point>...HEAD`.
2. **Invoke `fo-review`** — run the review skill inline via the `skill` tool, passing the diff scope. Wait for it to complete (mechanical floor, seven axes, spec compliance, persist report + commit). If the `skill` tool call fails, retry once. If it fails again, proceed to step 4.11 and note the failure in the report.
3. **Read the review report** — extract the verdict and all findings.

If the review verdict is **Approved** with zero findings, skip step 4.10 and proceed directly to step 4.11 (Report).

## 4.10. Fix findings (fo-fix) — MANDATORY if findings exist

If the review has ANY findings — this step MUST be executed — it is not optional. "Findings" means any issue noted under any review axis (A–G), regardless of severity label ("minor", "cosmetic", "advisory") or the review's overall verdict. An **approved** verdict with minor findings **still requires** `fo-fix` — do not skip because the verdict is "approved" or findings are "minor". The only case where this step is skipped is a review with **zero findings** (every axis says "No issues."):

1. **Re-verify findings** — before fixing, quickly check whether each finding is still relevant: the flagged code may have been changed by a subsequent step. Discard stale findings.
2. **Invoke `fo-fix`** — run the fix skill inline via the `skill` tool. It reads the persisted review report, applies fixes in priority order, runs scoped typecheck verification, commits, and delegates doc updates to `fo-doc-audit`. Wait for it to complete. If the `skill` tool call fails, retry once. If it fails again, proceed to step 4.11 and note the failure in the report.
3. **Re-run scoped build checks** if `fo-fix` made code changes — repeat step 4.4 for any workspaces touched by the fixes.

If the review verdict is **Approved** with zero findings, skip this step — no fix is needed.

## 4.11. Report

After implementation, review, and fix are complete, report:

```
## ADR-XXXX Implementation Summary

### Decision: <one-line summary>
### Phases implemented: <count>
### Commits: <count>
### Scoped build: <Pass | Fail — fixed>
### Review: <verdict> — <N> findings
### Fix: <done, <N> findings fixed | skipped, no findings>
### Status: implemented (<date>)
```
