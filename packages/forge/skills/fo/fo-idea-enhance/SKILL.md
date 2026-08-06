---
name: fo-idea-enhance
description: Enhance RFCs by integrating audit findings. Fixes gaps, DNA misalignment, drift, and blind spots. May split out new RFCs. Use after fo-idea-audit or when asked to enhance an RFC.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile]
triggers: ["enhance this RFC", "fix audit findings in RFC", "improve RFC based on audit"]
---

# RFC Enhance

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Integrate audit findings into an RFC to produce a final, implementation-ready version. The enhance skill reads the audit report, resolves open questions, fixes identified issues, and splits out new RFCs when findings reveal topics that deserve separate treatment.

## Process

### 1. Identify the RFC(s)

The user may provide:

- **A single RFC**: `RFC-XXXX`, a filename, or a path.
- **A comma-separated list**: `RFC-XXXX, RFC-XXXX, RFC-XXXX` — process each in order.
- **A range**: `RFC-XXXX..RFC-XXXX` or `от RFC-XXXX до RFC-XXXX` — discover all RFC files in `docs/rfcs/` whose numeric id falls within the inclusive range, sort ascending, and process each in order.
- **Nothing**: if an RFC file is open in the IDE, use it. Otherwise, ask.

### 1.5. Prerequisite checks (per RFC)

Before running the enhance on each RFC, perform these checks **in order**. If any check fails, record the RFC as **skipped** in the batch summary with the reason, and immediately proceed to the next RFC in the batch. Do not stop the entire batch — skip and report.

1. **Prefix check** — if the id starts with `ADR-`, this is not an RFC. Skip with message: `ADR-XXXX is an ADR, not an RFC. ADRs do not have an enhance step. The ADR pipeline is: create → implement. Run /fo-idea-implement ADR-XXXX to implement.`

2. **RFC file exists** — look for `docs/rfcs/rfc-XXXX-*.md`. If no file is found, skip with message: `RFC-XXXX not found in docs/rfcs/. Run /fo-idea-create-rfc first.`

3. **Terminal status check** — read the RFC's `status` frontmatter. If the status is `implemented`, `rejected`, or `superseded`, skip with message: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be enhanced. To change this decision, create a new RFC with supersedes: [RFC-XXXX] via /fo-idea-create-rfc.`

4. **Accepted status check** — if the status is `accepted`, skip with message: `RFC-XXXX is accepted. Accepted RFCs cannot be edited in place. Run /fo-idea-create-rfc with amends: [RFC-XXXX] to create an amending RFC, or supersedes: [RFC-XXXX] to create a superseding RFC.`

If all checks pass, proceed to step 2 for this RFC.

### 1.6. Batch processing

When multiple RFCs are identified, **loop through each one** and run the full enhance (steps 2–11) for each RFC sequentially **without pauses between RFCs**. Do not stop, present a summary, or ask the user between RFCs — once the enhancement for one RFC is committed (or it is skipped), immediately proceed to the next RFC. **Do not emit transition messages such as "Moving to RFC-XXXX next" or per-RFC status reports during the loop.** Internal status is fine, but nothing is shown to the user until the very end. Only after all RFCs are enhanced, print a single final batch summary.

**Exception:** Step 5 (resolve audit questions and grill the design) is inherently interactive — it may require user responses for questions the AI could not answer itself. This is not a "pause between RFCs" but a required step within one RFC's enhancement. Resolve all questions for the current RFC before proceeding to step 6, then continue to the next RFC without additional pauses.

Read the full RFC file at `docs/rfcs/rfc-XXXX-*.md` for the first RFC to process.

### 2. Find the audit

Look for the audit report in `docs/audits/`:

1. **Canonical**: `audit-rfc-XXXX-…md` — the output of `fo-idea-audit`.
2. **Legacy**: any file starting with `audit-rfc-XXXX` and ending in `.md` — older audit transcripts from other tools.

If a canonical audit file exists, use it. If only legacy files exist, use the most recent one. If no audit file exists at all, **stop with message**: `No audit report found for RFC-XXXX in docs/audits/. Run /fo-idea-audit RFC-XXXX first. The pipeline is: create → audit → enhance → plan → implement.`

### 3. Normalize to draft

Read the RFC's `status` frontmatter:

- **`draft`** — proceed with enhancement.
- **`reviewing`** — transition to `draft` before enhancement. Set `status: draft`, update `updatedAt` to today's date, commit:

  > Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```txt
  rfc: revert RFC-XXXX to draft for enhancement

  Transition RFC-XXXX from reviewing to draft before enhance.
```

Stage only the RFC file. Then proceed with enhancement.

**No RFC may begin enhancement in any status other than `draft`.** The transition to `draft` is mandatory and must be committed before proceeding to step 4. (Terminal and accepted statuses are already filtered out in step 1.5.)

### 4. Classify findings

Read every finding from the audit report. For each, classify it as one of:

- **Direct fix** — the RFC text can be edited to address it: fill a placeholder section, add a missing edge case, fix a DNA reference, tighten a contract, add a failure mode, etc.
- **New RFC** — the finding reveals a topic that is too large or too distinct for this RFC. Examples: a new package, a new DNA invariant, a new governance policy, a new external contract. Splitting it out keeps the RFC focused and follows the ecosystem's one-decision-per-RFC principle.
- **Out of scope** — the finding is valid but belongs to a different RFC or a future effort. Add it to this RFC's `nonGoals` with a brief explanation and, if applicable, a `related` reference to where it will be addressed.
- **NC (Needs Clarification)** — Unresolved `NEEDS CLARIFICATION` markers in the RFC body. Resolution: ask the operator the question, replace the marker line with the operator's answer in the RFC body. If the operator defers, the marker remains and the RFC cannot transition to `reviewing`.

Record the classification for every finding — the summary in step 8 reports it.

### 5. Resolve audit questions and grill the design

This step is **blocking** — the enhance skill must not proceed to step 6 until all audit questions are resolved and grilling is complete. Skipping unresolved audit questions defeats the purpose of the audit and is **not permitted**.

#### 5a. Extract and resolve audit questions

Read the "Questions for the author" section from the audit report. For each question, **first attempt to find a confident answer yourself**:

1. **Search the ecosystem** — explore existing code, DNA invariants, AGENTS.md rules, existing RFCs, package contracts, and command surfaces. If the answer is determined by existing artifacts, use it. Note it as "resolved from ecosystem: <explanation>" in the summary. Do not ask the user what can be found by exploring.
2. **Reason from existing patterns** — if the answer is not directly stated but follows unambiguously from existing conventions, architecture decisions, or established patterns in the codebase, derive it. Note it as "resolved by inference: <explanation>" in the summary.
3. **Ask only if you could not find a confident answer** — if after a genuine attempt you cannot find or derive the answer, ask the user via `ask_user_question`. Present the question with a recommended option first, marked "(recommended)". Ask one question at a time, waiting for the answer before continuing to the next question.

Do not ask the user a question you could have answered yourself. Do not skip a question you genuinely could not answer — that defeats the audit.

If the audit has no "Questions for the author" section or the section is empty, skip to 5b.

#### 5b. Grill the design

After all audit questions are answered, invoke the `grilling` skill to stress-test the RFC's design beyond the audit questions. Use the `skill` tool with `SkillName: "grilling"` to load the grilling instructions, then follow them: ask questions one at a time, provide a recommended answer for each, and wait for the user's response before continuing.

The grilling questions should probe the RFC's design decisions, edge cases, and integration points that the audit may not have covered. Focus on areas the audit flagged as "Needs revision" or where the answers to 5a revealed uncertainty.

If the user explicitly says they don't want further grilling, respect their wish and proceed to 5c.

#### 5c. Integrate answers

After all questions (audit + grilling) are answered, integrate each answer into the RFC text as a new subsection or within an existing section. Record the answers for the summary in step 9.

### 6. Create new RFCs

For each finding classified as **New RFC**:

1. **Create the RFC** using `rfc.create`:
   ```sh
   ref(forge.yaml bindings.commands.validateRfc) --create --title="<imperative title>" --kind=<architecture|contract|command|policy> --scope=<app|workspace>
   ```
2. **Fill the new RFC** — write its Context explaining it was split from the triggering RFC during audit enhancement. Reference the triggering RFC in `related[]`.
3. **Cross-reference** — add the new RFC's id to the triggering RFC's `related[]` frontmatter. In the triggering RFC's body, replace the split-out topic with a brief note and a reference to the new RFC.
4. **Run `rfc.validate`** on the new RFC to verify it passes mechanical validation.

The new RFC starts as `draft` — it cannot be implemented until human architecture acceptance.

### 7. Apply direct fixes

Edit the RFC to address every finding classified as **Direct fix**. Work through the audit axes in order:

- **Axis A (Structural)** — fill placeholder sections, tighten the Decision statement, add concrete CLI invocations, complete the file-system table, document the `--json` output shape, specify failure modes, write an honest Alternatives section, add agent-misinterpretation risks, make acceptance criteria checkable.
- **Axis B (DNA)** — fix `satisfies[]` entries to match the body's actual claims, add the "how" explanation for each DNA invariant, resolve silent conflicts (either fix the RFC or note the need for a superseding RFC).
- **Axis C (Ecosystem)** — fix package boundary violations, correct pipeline placement, add Compass sync notes, add AGENTS.md update requirements, fix cosmic naming references, correct command lifecycle buckets.
- **Axis D (Forward-only)** — remove compatibility shims, bridges, dual-paths, and legacy-maintenance-behind-a-flag language. Deprecation means removal, not a grace period.
- **Axis E (Agent-facing)** — remove self-authorizing language, add correct governance rule references (RFC-XXXX, RFC-XXXX, RFC-XXXX, RFC-XXXX), distinguish code-changes from content-authoring in acceptance criteria, remove any cookie usage.
- **Axis F (Pragmatism)** — consolidate redundant commands into flags, remove speculative generality from TypeScript contracts, add "why extension was insufficient" to Alternatives, tighten `appsImpacted`/`packagesImpacted` lists.
- **Axis G (Blind spots)** — add performance notes for build-time commands, document false-positive rates and suppression mechanisms, add edge case coverage (empty states, concurrent execution, interrupted operations), document migration paths, add security/privacy considerations.

For findings classified as **Out of scope**, add entries to the `nonGoals` frontmatter list with a brief explanation.

### 7.5 Stamp enhancedAt

Set the `enhancedAt` field in the RFC's frontmatter to today's date (YYYY-MM-DD). This is the persistent marker that downstream skills (`fo-idea-plan`, `fo-idea-implement`) check to determine whether enhance has been run. Also update `updatedAt` to today's date.

This step is mandatory even if the audit verdict was "Approved" and zero direct fixes were applied — the stamp confirms the audit was reviewed and no changes were needed, which is distinct from "enhance was never run".

### 8. Validate

Run mechanical validation on all modified and created RFCs:

```sh
ref(forge.yaml bindings.commands.validateRfc) --json
```

If any violations target the enhanced RFC or new RFCs, fix them and re-run. Do not stop until `rfc.validate` is clean for all touched RFCs.

### 9. Summary

Present a concise summary of changes made in `aiLanguage`. **Translate all labels and headings to `aiLanguage`** — the template below is structural only.

```
## <RFC-XXXX Enhancement Summary in aiLanguage>

### Verdict from audit: <Approved | Needs revision | Rejected>

### Direct fixes applied: <count>
- <one-line per fix, grouped by axis>

### New RFCs created: <count>
- RFC-YYYY: <title> — split from <axis/finding>

### Audit questions resolved: <count>
- <one-line per question: "resolved from ecosystem: <explanation>" | "resolved by inference: <explanation>" | "asked: <user's answer>">

### Grilling questions asked: <count>
- <one-line per question, with the user's answer>

### Out of scope (added to nonGoals): <count>
- <one-line per item>

### Validation: <Pass | Fail — details>
```

### 10. Commit

Commit all modified and created RFCs. This is **mandatory** — the enhancement must be committed, not left in the working tree.

Commit message format:

```txt
enhance: RFC-XXXX <short description>

Integrate audit findings into RFC-XXXX (<title>). <count> direct fixes,
<count> new RFCs created, <count> audit questions resolved, <count> grilling questions asked.
```

Stage only the RFC files and audit files touched by this enhancement — do not stage unrelated changes.

### 11. Stop

Do not run `/fo-idea-plan` — that is a separate skill for accepted RFCs. If the user asks to plan implementation, suggest running `/fo-idea-plan` after the RFC is accepted. If the user asks to implement, suggest running `/fo-idea-implement` — it requires a plan file and will stop if one is missing. The full pipeline is: create → audit → enhance → plan → implement.

## Constraints

- **Commit only your own files.** Stage only the files this skill produces or modifies — the RFC file(s), audit file(s), and any new RFCs created during enhancement. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- The enhance skill **only edits RFCs with status `draft`**. If the RFC is `reviewing`, it must be transitioned to `draft` and committed first (step 3). Accepted, implemented, rejected, and superseded RFCs are not editable in place.
- New RFCs created during enhancement are always `draft` — they require human architecture acceptance before implementation.
- The enhance skill **must not weaken existing DNA invariants**. If a finding requires changing a DNA invariant, the enhance skill creates a superseding RFC instead of editing the original.
- The enhance skill **must not introduce backward compatibility layers, shims, or dual-paths**. The ecosystem is forward-only.
- The enhance skill **must not add self-authorizing language** to any RFC. Draft RFCs cannot grant implementation permission.
- Every edit must be grounded in an audit finding — the enhance skill does not make changes the audit did not call for.
- The enhance skill **must run `rfc.validate`** after all changes and fix any violations before presenting the summary.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — e.g. `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — do not stop and ask the user. Recover autonomously: split the content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".
