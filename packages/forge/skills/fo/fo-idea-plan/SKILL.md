---
name: fo-idea-plan
description: Plan RFC implementation — ensure audit/enhance done, map affected artifacts, draft a step-by-step plan with validation and evidence, and persist it. Use when an RFC needs an implementation plan.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile, paths.compassDocs]
triggers: ["plan the implementation for this RFC", "create implementation plan", "map affected artifacts and draft steps"]
---

# Plan RFC Implementation

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Create a structured implementation plan for an accepted (or pilot-approved) RFC. The plan fixes the step sequence, affected artifacts, validation suite, and evidence strategy **before** code changes begin — making implementation predictable, repeatable, and verifiable.

## Process

### 0. Identify the RFC(s) and verify prerequisites

The pipeline is: create → audit → enhance → plan. Audit and enhance are **mandatory** — no RFC may proceed to planning without both being completed. This is critical because enhance can only edit the RFC while it is still `draft` — if the RFC is `reviewing`, enhance will transition it to `draft` first. Once it becomes `accepted`, enhancement is no longer possible in place.

**Do not skip these checks for `accepted` RFCs.** An RFC may have been accepted manually without going through the pipeline. The checks below apply to every RFC regardless of status.

#### 0.1. Identify the RFC(s)

The user may provide:

- **A single RFC**: `RFC-XXXX`, a filename, or a path.
- **A comma-separated list**: `RFC-XXXX, RFC-XXXX, RFC-XXXX` — process each in order.
- **A range**: `RFC-XXXX..RFC-XXXX` or `от RFC-XXXX до RFC-XXXX` — discover all RFC files in `docs/rfcs/` whose numeric id falls within the inclusive range, sort ascending, and process each in order.
- **Nothing**: if an RFC file is open in the IDE, use it. Otherwise, ask.

When multiple RFCs are identified, **loop through each one** and run the full plan (steps 0–7) for each RFC sequentially **without pauses between RFCs**. Do not stop, present a summary, or ask the user between RFCs — once the plan for one RFC is committed (or it is skipped), immediately proceed to the next RFC. **Do not emit transition messages such as "Moving to RFC-XXXX next" or per-RFC status reports during the loop.** Internal status is fine, but nothing is shown to the user until the very end. Only after all RFCs are planned, print a single final batch summary.

#### 0.2. Prerequisite checks (per RFC)

Before running the plan on each RFC, perform these checks **in order**. If any check fails, record the RFC as **skipped** in the batch summary with the reason, and immediately proceed to the next RFC in the batch. Do not stop the entire batch — skip and report.

1. **Prefix check** — if the id starts with `ADR-`, this is not an RFC. Skip with message: `ADR-XXXX is an ADR, not an RFC. ADRs do not have a plan step. The ADR pipeline is: create → implement. Run /fo-idea-implement ADR-XXXX to implement.`

2. **RFC file exists** — look for `docs/rfcs/rfc-XXXX-*.md`. If no file is found, skip with message: `RFC-XXXX not found in docs/rfcs/. Run /fo-idea-create-rfc first.`

3. **Terminal status check** — read the RFC's `status` frontmatter. If the status is `implemented`, `rejected`, or `superseded`, skip with message: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be planned. To change this decision, create a new RFC with supersedes: [RFC-XXXX] via /fo-idea-create-rfc.`

4. **Audit check** — look for `docs/audits/audit-rfc-XXXX-*.md`. If no audit file exists, skip with message: `No audit report found for RFC-XXXX in docs/audits/. Run /fo-idea-audit RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`

5. **Enhance check** — read the RFC's frontmatter and look for the `enhancedAt` field. If `enhancedAt` is absent, skip with message: `RFC-XXXX has not been enhanced (no enhancedAt in frontmatter). Run /fo-idea-enhance RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`

6. **Accepted status check** — if the status is `accepted` and both audit and enhance are done, prerequisites are met. Proceed to step 1.

If all checks pass, proceed to step 0.3.

#### 0.3. Transition draft → accepted

If the RFC is `draft` or `reviewing` and has `enhancedAt` — the user's instruction to plan IS the architecture acceptance. Transition the RFC to `accepted`:

1. Set `status: accepted`.
2. Set `reviewers` — if the operator specified a reviewer at invocation, use that. Otherwise, read the default reviewer(s) from the `reviewers` field comment in `os/rfc/rfc-0000-template.md` inside `@warpgogol/forge` (currently `human:andrii-syrokomskyi`). Set all listed default reviewers.
3. Set `updatedAt` to today's date.
4. Commit:

   > Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```txt
   rfc: accept RFC-XXXX <short title>

   Transition RFC-XXXX to accepted status for planning.
```

5. Stage only the RFC file.

Then proceed to step 1.

**Inherited acceptance.** If the RFC has a `specRef` frontmatter field pointing to a spec with `status: accepted`, the acceptance inheritance path applies:

1. Check the audit report for this RFC — if the audit verdict is `approved`, the RFC MAY transition `draft → accepted` without a separate human acceptance ceremony. Record `reviewers` from the spec's `reviewers` field and note `via spec acceptance <spec-id>` in the commit message.
2. If the audit verdict is `needs-revision` or `rejected`, inheritance is void — a human decision is required. Do not transition; ask the operator.
3. If the `specRef` points to a spec with `status: vendored` (not yet accepted), the RFC cannot progress past `draft` — V-SPEC-03 blocks it.

### 1. Read the RFC

Read the RFC file at `docs/rfcs/rfc-XXXX-*.md` and extract:

- **Decision** — the single decision being made.
- **Architectural fit** — which DNA invariants it enforces or protects, which existing building blocks it aligns with.
- **Design** — CLI surface, TypeScript contracts, file system responsibilities, output format, failure modes.
- **Rollout** — adoption path, pipeline integration, deprecation path.
- **Risks** — technical, organizational, agent-facing.
- **Acceptance criteria** — the checkboxes that gate the `accepted → implemented` transition.
- **Implementation notes for agents** — behavioral policy, constraints, escalation triggers.
- **Frontmatter** — `commands.proposed/added/changed/removed`, `appsImpacted`, `packagesImpacted`, `satisfies` (DNA trace, RFC-XXXX), `acceptance` probes.

### 2. Explore the codebase

Verify the RFC's claims about affected artifacts. Check:

- Which `packages/*` export the types/commands that need changing.
- Which `apps/*` consume them and need migration.
- Which `services/*` are impacted.
- Which `docs/*.xml` Compass files need synchronization (per root AGENTS.md Compass document duties).
- Which `AGENTS.md` files (root, `apps/`, `packages/`, `services/`) need rule updates.
- Which pipelines (`build.check`, `build.prepare`, `sites-check`, `sites-check-postbuild`) the new commands join.
- Whether `rfc.supersede.propose` is needed for any invariant conflict discovered during exploration.

### 3. Resolve open questions

After exploring, identify decisions the RFC leaves open — ambiguities, trade-offs, unspecified boundaries, conflicting constraints. These are **decisions**, not facts: if a fact can be found by exploring the codebase, look it up instead of asking.

Walk the user through each question **one at a time**. For each:

1. **Short context** — what the question is, why the plan needs it resolved, what changes depending on the answer.
2. **Options** — list 2-4 concrete options, **recommended option first**. Mark it with "(recommended)". Each option is a short label plus one line explaining the trade-off.
3. **Wait** — present the question and stop. Do not batch multiple questions; asking several at once is bewildering.

Use the `ask_user_question` tool when available, with the recommended option as the first entry. Otherwise, present the question inline and wait for the answer.

Typical questions that arise:

- **Scope boundary** — the RFC names several packages; which are in-scope for this plan vs. deferred to a follow-up?
- **Migration strategy** — fail-hard from day one, warn-first with a grace period, or opt-in with a flag?
- **Pipeline placement** — does the new check join `build.check` (blocking) or `sites-check-postbuild` (advisory)?
- **Backward compatibility** — forward-only break, or expand-then-contract migration?
- **Test seam** — unit test at the handler level, integration test through the CLI, or both?
- **Compass sync** — which `docs/*.xml` files need updates, and is this a structural change or a content-only refresh?

If exploration surfaces no open questions, skip this step and proceed directly to drafting.

### 4. Draft the plan

Copy `docs/plans/plan-0000-template.md` and fill it, incorporating the user's answers from step 3. Each step must have a **completion criterion** — a checkable condition that tells the agent the step is done.

Step ordering follows the contract-first pattern:

1. **Contracts** — types, schemas, frontmatter fields, ontology catalogs.
2. **Commands** — Site OS command handlers, registry, pipeline wiring.
3. **Documentation** — `AGENTS.md`, Compass XML (`ref(forge.yaml bindings.paths.compassDocs)`), `ref(forge.yaml bindings.paths.invariantsFile)` (if new DNA invariant).
4. **Tests** — unit tests, fixture files, test matrix.
5. **Validation** — run `rfc.validate`, `build:check`, acceptance probes.
6. **Evidence** — run `rfc.verification.emit`, commit evidence file.
7. **Review & Fix** — `fo-review` on all session code changes, `fo-fix` if findings (MANDATORY — do not omit from the plan).
8. **Stamp implemented** — run `rfc.implement.stamp --id RFC-XXXX --implementation-commit <sha>` to transition `accepted → implemented` (RFC). For ADRs, manually set `status: implemented` and `implementedAt` per `fo-idea-implement` step 4.10.

Mark **human review points** on steps that:

- Change or establish a DNA invariant (requires a new RFC, not an implementation step).
- Change an external contract (Stripe, Supabase, Cloudflare, UChat, Matomo).
- Change security or privacy policy.
- Change the RFC governance process itself.

### 5. Grill the plan

Invoke the `/grilling` skill to stress-test the draft plan before persisting. This is **mandatory**, not optional — every plan goes through grilling.

The grilling checks:

- Are the objectives concrete enough to verify?
- Does the step ordering have hidden dependencies?
- Are completion criteria actually checkable, not vague?
- Are human review points placed where they should be?
- Does the validation suite cover the acceptance criteria?
- Are risks mapped to specific mitigating steps, not just listed?
- Could an agent following this plan get stuck or confused?

Address every concern the grilling raises by revising the draft. Do not persist until the grilling is satisfied.

### 5b. Summit suggestion

If the RFC meets summit criteria (any of: `kind: architecture` AND `scope: workspace`, `satisfies[]` includes 2+ DNA invariants, introduces a new package/command/lifecycle, supersedes an implemented RFC), suggest using `fo-design-summit` before acceptance. Use `ask_user_question`:

> "This RFC is complex (architecture, workspace scope, 2+ DNA invariants). Should I run a multi-persona design summit before acceptance?"

Recommended option: "Run summit" — because complex RFCs benefit from multi-perspective review.

If the operator declines, proceed to step 6. If the operator accepts, invoke `fo-design-summit` via the `skill` tool, wait for it to complete, then proceed to step 6.

### 6. Persist the plan

Name the plan file by mirroring the RFC filename with a `plan-` prefix:

```txt
docs/rfcs/rfc-0001-introduce-rfc-governance-process.md
  → docs/plans/plan-rfc-0001-introduce-rfc-governance-process.md
```

Do **not** modify the RFC file itself — the plan references the RFC by `rfcId`, not the other way around.

### 7. Commit

Commit the plan file. This is **mandatory** — the plan must be committed, not left in the working tree.

Commit message format:

```txt
plan: RFC-XXXX <short description>

Add implementation plan for RFC-XXXX (<title>).
```

Reference the RFC ID in the commit subject. Stage only the plan file — do not stage unrelated changes.

### 8. Final batch summary

This step runs only once, after every RFC in the batch has been planned through steps 0–7. Do not run this step after each individual RFC.

If only one RFC was requested, confirm briefly:

```
Plan created: docs/plans/plan-rfc-XXXX-*.md
```

If multiple RFCs were processed, present a single batch summary in `aiLanguage`. **Translate all labels, headings, and column names to `aiLanguage`** — the template below is structural only.

```
## <Batch Plan Summary in aiLanguage>

### RFCs planned: <N>
### RFCs skipped/errored: <list with reason>

| RFC | Plan path | Status |
| --- | --- | --- |
| RFC-XXXX | docs/plans/... | created |
| RFC-XXXX | docs/plans/... | created |
...
```

Do not output per-RFC summaries or "Moving to RFC-XXXX next" messages during the loop; they belong here, at the very end.

## Constraints

- **Commit only your own files.** Stage only the files this skill produces or modifies — the plan file and the RFC file (for status transitions). Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- **Audit and enhance are mandatory.** No RFC may proceed to planning without both an audit file in `docs/audits/` and `enhancedAt` in the RFC frontmatter. This applies regardless of RFC status — an `accepted` RFC may have been accepted manually without the pipeline. Never skip these checks. If either is missing, skip the RFC with a clear message directing the user to the missing step.
- The agent MAY transition `draft`/`reviewing` → `accepted` in this skill (step 0.3) after enhance is complete. This is the only RFC file modification permitted — the plan itself references the RFC by `rfcId`.
- The plan describes steps but does NOT authorize execution — use `/fo-idea-implement` to execute.
- The plan MUST NOT propose changing DNA invariants without a new superseding RFC.
- The plan MUST respect RFC-XXXX: only `accepted → implemented` is agent-permitted; all other status transitions are human-only. The `draft → accepted` transition in step 0.3 is an exception authorized by the user's explicit instruction to plan the RFC.
- The plan MUST reference the RFC's acceptance criteria as the source of truth for completion.
- **Default reviewer source.** When transitioning `draft → accepted` and the operator has not specified a reviewer, read the default reviewer(s) from the `reviewers` field comment in `os/rfc/rfc-0000-template.md` inside `@warpgogol/forge` (currently `human:andrii-syrokomskyi`). Set all listed default reviewers.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — e.g. `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — do not stop and ask the user. Recover autonomously: split the content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".
