# WG Pipeline Prerequisites & Batch Processing

Reference for `fo-idea-audit`, `fo-idea-enhance`, `fo-idea-plan`, `fo-idea-implement`. These skills share identical input parsing, prerequisite checks, and batch loop behavior.

## Input parsing

The operator may provide:

- **A single id**: `RFC-0362`, `ADR-0003`, a filename, or a path.
- **A comma-separated list**: `RFC-0355, RFC-0356, RFC-0357` — process each in order.
- **A range**: `RFC-0355..RFC-0360` or `от RFC-0355 до RFC-0360` — discover all files in `docs/rfcs/` whose numeric id falls within the inclusive range, sort ascending, and process each in order. Ranges are only valid within a single document type (RFC or ADR).
- **Nothing**: if a document file is open in the IDE, use it. Otherwise, ask.

## Common prerequisite checks

Run these **in order** for each document. If any check fails, record the document as **skipped** in the batch summary with the reason, and immediately proceed to the next document. Do not stop the entire batch — skip and report.

1. **Prefix check** — if the id starts with `ADR-` and this skill handles RFCs only, skip with: `ADR-XXXX is an ADR, not an RFC. ADRs do not have <this step>. The ADR pipeline is: create → implement (includes review → fix). Run /fo-idea-implement ADR-XXXX to implement.`

   If the id starts with `RFC-` and this skill handles ADRs only, skip with: `RFC-XXXX is an RFC, not an ADR. Use the RFC pipeline: create → audit → enhance → plan → implement (includes review → fix).`

2. **File exists** — look for `docs/rfcs/rfc-XXXX-*.md` (or `docs/adrs/adr-XXXX-*.md` for ADRs). If no file is found, skip with: `RFC-XXXX not found in docs/rfcs/. Run /fo-idea-create-rfc first.`

3. **Terminal status check** — read the document's `status` frontmatter. If the status is `implemented`, skip with: `RFC-XXXX is already implemented. Nothing to do.` If the status is `rejected` or `superseded`, skip with: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be <this action>. To change this decision, create a new RFC with supersedes: [RFC-XXXX] via /fo-idea-create-rfc.`

## Skill-specific prerequisite checks

After the common checks, each skill adds its own:

### fo-idea-audit

No additional checks.

### fo-idea-enhance

4. **Accepted status check** — if the status is `accepted`, skip with: `RFC-XXXX is accepted. Accepted RFCs cannot be edited in place. Run /fo-idea-create-rfc with amends: [RFC-XXXX] to create an amending RFC, or supersedes: [RFC-XXXX] to create a superseding RFC.`

### fo-idea-plan

4. **Audit check** — look for `docs/audits/audit-rfc-XXXX-*.md`. If no audit file exists, skip with: `No audit report found for RFC-XXXX in docs/audits/. Run /fo-idea-audit RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

5. **Enhance check** — read the RFC's frontmatter and look for the `enhancedAt` field. If `enhancedAt` is absent, skip with: `RFC-XXXX has not been enhanced (no enhancedAt in frontmatter). Run /fo-idea-enhance RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

6. **Accepted status check** — if the status is `accepted` and both audit and enhance are done, prerequisites are met. If the status is `draft` or `reviewing` and has `enhancedAt`, the user's instruction to plan IS the architecture acceptance — proceed to the draft→accepted transition.

### fo-idea-implement

4. **Audit check** — look for `docs/audits/audit-rfc-XXXX-*.md`. If no audit file exists, skip with: `No audit report found for RFC-XXXX in docs/audits/. Run /fo-idea-audit RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

5. **Enhance check** — read the RFC's frontmatter and look for the `enhancedAt` field. If `enhancedAt` is absent, skip with: `RFC-XXXX has not been enhanced (no enhancedAt in frontmatter). Run /fo-idea-enhance RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

6. **Accepted status check** — if the status is not `accepted` (e.g. `draft` or `reviewing`), skip with: `RFC-XXXX is <status>, not accepted. Run /fo-idea-plan RFC-XXXX first — it will transition the RFC to accepted and create the plan. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

7. **Plan check** — look for `docs/plans/plan-rfc-XXXX-*.md`. If no plan file exists, skip with: `No plan file found for RFC-XXXX in docs/plans/. Run /fo-idea-plan RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement (includes review → fix).`

## Batch processing

When multiple documents are identified, **loop through each one** and run the full skill process for each sequentially **without pauses between documents**. Do not stop, present a summary, or ask the user between documents — once the work for one document is committed (or it is skipped), immediately proceed to the next document. **Do not emit transition messages such as "Moving to RFC-XXXX next" or per-document status reports during the loop.** Internal status is fine, but nothing is shown to the user until the very end. Only after all documents are processed, print a single final batch summary.

**Exception:** Interactive steps within a skill (grilling, resolving open questions) are inherently interactive — they may require user responses. This is not a "pause between documents" but a required step within one document's processing. Resolve all interactions for the current document before proceeding to the next.

## Batch summary format

After all documents are processed, present a single batch summary:

```
## Batch <Action> Summary

### Documents requested: <N>
### Documents processed: <N>
### Documents skipped: <list with reason>

| ID | Type | Status | <action-specific columns> |
|---|---|---|---|
| RFC-0355 | RFC | <result> | ... |
| ADR-0003 | ADR | <result> | ... |

### Total commits: <count>
```

Do not output per-document summaries or "Moving to XXXX next" messages during the loop; they belong here, at the very end.
