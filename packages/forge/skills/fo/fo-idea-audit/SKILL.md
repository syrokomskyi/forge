---
name: fo-idea-audit
description: Audit RFCs for ecosystem fit, DNA alignment, forward-only compliance, agent policy, and pragmatism. Accepts a single id, list, or range. Use after creating or revising an RFC.
invocation: user
category: fo
concerns: read-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile, paths.compassDocs]
triggers: ["audit this RFC", "check RFC for ecosystem fit", "review RFC against DNA and forward-only rules"]
---

# RFC Audit

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

A read-only semantic review of an RFC against the ecosystem's actual structure, DNA invariants, and governance rules. The audit finds what `rfc.validate` cannot: drift between the RFC's claims and the ecosystem's reality, over-engineering, missing operational details, and agent-facing policy gaps.

The audit does **not** modify the RFC or any other file. It produces a structured report, persists it to `docs/audits/`, and stops.

## Process

### 1. Identify the RFC(s)

The user may provide:

- **A single RFC**: `RFC-XXXX`, a filename, or a path.
- **A comma-separated list**: `RFC-XXXX, RFC-XXXX, RFC-XXXX` — process each in order.
- **A range**: `RFC-XXXX..RFC-XXXX` or `от RFC-XXXX до RFC-XXXX` — discover all RFC files in `docs/rfcs/` whose numeric id falls within the inclusive range, sort ascending, and process each in order.
- **Nothing**: if an RFC file is open in the IDE, use it. Otherwise, ask.

### 1.5. Prerequisite checks (per RFC)

Before running the audit on each RFC, perform these checks **in order**. If any check fails, record the RFC as **skipped** in the batch summary with the reason, and immediately proceed to the next RFC in the batch. Do not stop the entire batch — skip and report.

1. **Prefix check** — if the id starts with `ADR-`, this is not an RFC. Skip with message: `ADR-XXXX is an ADR, not an RFC. ADRs do not have an audit step. The ADR pipeline is: create → implement. Run /fo-idea-implement ADR-XXXX to implement.`

2. **RFC file exists** — look for `docs/rfcs/rfc-XXXX-*.md`. If no file is found, skip with message: `RFC-XXXX not found in docs/rfcs/. Run /fo-idea-create-rfc first.`

3. **Terminal status check** — read the RFC's `status` frontmatter. If the status is `implemented`, `rejected`, or `superseded`, skip with message: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be audited. To change this decision, create a new RFC with supersedes: [RFC-XXXX] via /fo-idea-create-rfc.`

If all checks pass, proceed to step 2 for this RFC.

### 1.6. Batch processing

When multiple RFCs are identified, **loop through each one** and run the full audit (steps 2–8) for each RFC sequentially **without pauses between RFCs**. Do not stop, present a summary, or ask the user between RFCs — once the audit report for one RFC is persisted and committed (or it is skipped), immediately proceed to the next RFC. **Do not emit transition messages such as "Moving to RFC-XXXX next" or per-RFC status reports during the loop.** Internal status is fine, but nothing is shown to the user until the very end. Only after all RFCs are processed, print a single final batch summary.

Read the full RFC file at `docs/rfcs/rfc-XXXX-*.md` for the first RFC to process.

### 2. Run mechanical validation

Run the mechanical floor first — it catches format, referential, and structural violations that don't need semantic judgment:

```sh
ref(forge.yaml bindings.commands.validateRfc) --json
```

Record any violations targeting this RFC. The semantic audit starts from a clean mechanical baseline; if `rfc.validate` already fails on this RFC, report it and still continue with the semantic axes — the human needs the full picture.

### 3. Load ecosystem context

Read the context the RFC claims to fit into:

- `ref(forge.yaml bindings.paths.invariantsFile)` — all DNA invariants referenced in `satisfies[]` or `related[]`.
- `AGENTS.md` (root) — RFC governance protocol, storage policy, cosmic naming contract, Compass duties, CKL, agent surface.
- The closest nested `AGENTS.md` for the RFC's scope (`docs/authoring/site-composition.md`, `packages/AGENTS.md`, `services/AGENTS.md`).
- Each RFC listed in `amends[]`, `supersedes[]`, `related[]` — read enough to understand what this RFC builds on or changes.
- `docs/requirements.xml`, `docs/technology.xml`, `docs/development-plan.xml` — if the RFC is workspace-scoped or architectural.
- The package manifests (`package.json`) of any `packagesImpacted` entries — verify the package exists and check its current exports.

Do not read every RFC in the repo — only those the RFC explicitly references, plus the DNA and AGENTS files.

### 4. Run the seven audit axes

For each axis below, check every item. An item either **passes**, **fails** (specific finding with evidence), or is **not applicable** (state why). Skip N/A items silently — do not pad the report.

#### Axis A — Structural completeness

Beyond V-13 (required sections exist) and V-14 (≥3 acceptance items), check that each section contains real content, not template placeholders or empty HTML comments:

- **Decision** is a single decision in present tense ("The kernel gains…"), not a wishlist or "we should".
- **CLI surface** shows exact command invocations with flags and scope (resolved from `ref(forge.yaml bindings.commands.*)`).
- **TypeScript contracts** are minimal type signatures, not full implementations.
- **File system responsibilities** table names concrete paths the RFC touches.
- **Output format** documents the `--json` shape.
- **Failure modes** specifies exit codes and warn-vs-fail behavior.
- **Rollout** describes default behavior, adoption path for existing apps, and new-app compliance.
- **Alternatives considered** is honest — at least one real alternative with a rejection reason.
- **Risks** includes agent misinterpretation risk and false-positive rate for validators.
- **Acceptance criteria** items are checkable (can an agent or human verify each one?) and sufficient (do they cover the decision's full scope?).
- **Implementation notes for agents** are explicit behavioral rules, not vague guidance.

#### Axis B — DNA alignment

- Each entry in `satisfies[]` is a real DNA invariant in `ref(forge.yaml bindings.paths.invariantsFile)`, and the RFC body explains **how** it enforces, protects, or extends that invariant — not just that it's "related".
- If the RFC establishes a new DNA invariant (body says "DNA-N established by this RFC"), the audit confirms `ref(forge.yaml bindings.paths.invariantsFile)` will need a new `## DNA-N` entry and the RFC's `satisfies[]` includes it.
- The RFC does not silently conflict with any existing DNA invariant. If it changes a DNA invariant, it must `supersede` the establishing RFC — not amend it.
- `related[]` DNA references are relevant and not decorative.

#### Axis C — Ecosystem fit

- **Package boundaries**: imports flow `apps/* → packages/*` and `services/* → packages/*`, never `apps/* → apps/*` or `apps/* → services/*` (DNA-1). If the RFC proposes a new package, it belongs in `packages/*`.
- **Pipeline placement**: the RFC names the correct pipeline for each new check — `build.prepare`, `build.check`, `sites-check`, `sites-check-postbuild` — and the choice is justified (blocking vs. advisory).
- **Compass sync**: if the RFC changes repository-wide requirements, shared package contracts, or app-package relationships, it identifies which `docs/*.xml` files need synchronization (root AGENTS.md Compass document duties).
- **AGENTS.md updates**: the RFC identifies which `AGENTS.md` files need rule updates (root, `apps/`, `packages/`, `services/`, or site-specific).
- **Cosmic naming**: if the RFC touches manifests or component/section/page contracts, it addresses the three-way alignment (manifest `cosmicName` ↔ `PLANET_IMPORT_PATHS`/`MOON_IMPORT_PATHS` ↔ `system.md` pins).
- **Command lifecycle**: `commands.proposed/added/changed/removed` buckets are internally consistent — proposed commands that the RFC introduces will land in `added` upon implementation; changed commands are existing registered commands; removed commands are explicitly deprecated.

#### Axis D — Forward-only compliance

This ecosystem is forward-only — no backward compatibility layers, no expand-then-contract migrations. Check:

- The RFC does not propose a compatibility shim, bridge, or dual-path that keeps legacy behavior alive alongside the new one.
- Deprecation means removal in the same RFC wave, not an indefinite grace period.
- If the RFC amends another RFC, it changes the amended RFC's contract directly — it does not add a parallel interpretation.
- Legacy code paths are deleted, not maintained behind a flag.

#### Axis E — Agent-facing policy

- **Status gate**: the RFC does not contain self-authorizing language ("may proceed while draft", "implementation can start before acceptance"). Draft RFCs cannot grant implementation permission.
- **Implementation notes** reference the correct governance rules: RFC-XXXX (accepted→implemented transition), RFC-XXXX (if touching agent surface), RFC-XXXX (supersede escalation on invariant conflict), RFC-XXXX (verification evidence for probe-bearing RFCs).
- **Anti-fabrication**: if the RFC's acceptance criteria include content authoring (prose, business records, claims), the criteria distinguish between code changes an agent can make and content that requires human authoring. The RFC must not claim content will be "auto-generated" when it requires human authoring.
- **Storage policy**: if the RFC touches persistence, it does not introduce cookies (`document.cookie`, `Set-Cookie`). Client-side persistence is `localStorage` only; server-side is `unstorage`.

#### Axis F — Pragmatism

- **Minimal command surface**: each proposed command earns its existence — no command that could be a flag on an existing command, no command that duplicates an existing command's scope.
- **Lean contracts**: TypeScript types are the minimum needed to understand the shape — no speculative generality, no unused optional fields, no abstraction for needs the RFC doesn't have.
- **Existing patterns**: the RFC checks whether an existing command, schema, or pattern can be extended before proposing a new one. If a new one is proposed, the alternatives section explains why extension was insufficient.
- **Scope discipline**: `appsImpacted` and `packagesImpacted` list only what's actually impacted. `nonGoals` are explicit and meaningful, not boilerplate.

#### Axis G — Blind spots

- **Performance**: build-time commands specify their cost (file scan count, regex complexity, I/O patterns). A command that scans all `apps/**` on every `build.check` is a bottleneck.
- **False positives**: validators estimate their false-positive rate and describe how to suppress noise during migration.
- **Edge cases**: the RFC considers empty states (new app with no content, package with no manifests), concurrent execution (two builds, two agents), and interrupted operations (crash mid-write).
- **Migration path**: existing apps' path to compliance is documented — do they pass without changes, or is there a documented migration window?
- **Security/privacy**: if the RFC touches user data, PII, or external services, it addresses GDPR/privacy implications and secret management (no hardcoded keys, env vars documented in `.env.example` per DNA-40).

### 5. Produce the report

Present the findings in this structure. Keep it concise — each finding is one to three sentences with evidence (quote the RFC line or cite the file path).

```
## RFC-XXXX Audit

### Verdict: <Approved | Needs revision | Rejected>

<2-3 sentence justification grounded in the most serious findings.>

### Mechanical validation (rfc.validate)

<Pass / Fail — if fail, list violations targeting this RFC.>

### Axis A — Structural completeness
<Findings or "No issues.">

### Axis B — DNA alignment
<Findings or "No issues.">

### Axis C — Ecosystem fit
<Findings or "No issues.">

### Axis D — Forward-only compliance
<Findings or "No issues.">

### Axis E — Agent-facing policy
<Findings or "No issues.">

### Axis F — Pragmatism
<Findings or "No issues.">

### Axis G — Blind spots
<Findings or "No issues.">

### Questions for the author

1. <Hard question that the RFC must answer before implementation.>
2. <Hard question.>
3. <Hard question.>
```

**Verdict criteria:**

- **Approved** — zero findings across all axes. Any finding, no matter how minor or cosmetic, disqualifies Approved and forces Needs revision. The rationale: downstream agents treat Approved as a stop signal and stop reading the findings — so even a trivial finding left under Approved gets silently ignored. If there is anything to fix, the verdict must say so.
- **Needs revision** — one or more findings on any axis, regardless of severity. A one-line cosmetic note is enough. The agent must not downgrade to Approved based on severity — a finding is a finding.
- **Rejected** — fundamental flaw: the RFC contradicts a DNA invariant without superseding it, proposes a backward compatibility layer, or contains self-authorizing language that bypasses the status gate.

### 6. Persist the audit

Write the report to `docs/audits/` using the `audit-rfc-NNNN-…` prefix pattern (mirroring the `plan-rfc-NNNN-…` convention in `docs/plans/`):

```txt
docs/rfcs/rfc-0362-werkstatt-consistency-primitives-….md
  → docs/audits/audit-rfc-0362-werkstatt-consistency-primitives-….md
```

Use `docs/audits/audit-0000-template.md` as the structural starting point. The file must begin with a YAML frontmatter block:

```yaml
---
rfcId: RFC-XXXX
auditId: AUDIT-RFC-XXXX-01
date: YYYY-MM-DD
auditor:
  skill: fo-idea-audit
  model: <AI model identifier>
verdict: <approved | needs-revision | rejected>
---

# Audit: RFC-XXXX

(…report body…)
```

The `auditor.model` field must record the AI model identifier the skill is running on (e.g. `claude-sonnet-4-20250514`, `gpt-4o`, etc.). If the model cannot be determined, use `unknown`.

If the file already exists, overwrite it — the audit is always the latest run.

### 7. Commit

Commit the audit report. This is **mandatory** — the audit file must be committed, not left in the working tree.

Commit message format:

```txt
audit: RFC-XXXX <short description>

Semantic audit of RFC-XXXX (<title>). Verdict: <approved | needs-revision | rejected>.
```

Stage only the audit file — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

### 8. Stop

Do not modify the RFC or any other file. Do not run `/fo-idea-plan` or `/fo-idea-implement` — those are separate skills with different purposes. Present the report and stop. If the user asks to fix the findings, suggest running `/fo-idea-enhance` — it reads the persisted audit and applies the fixes. The full pipeline is: create → audit → enhance → plan → implement.

## Constraints

- The audit is **read-only** with respect to the RFC and codebase — the only file it writes is the audit report in `docs/audits/`.
- **Commit the audit report.** The audit file must be committed after persistence — never left in the working tree.
- The audit does **not** duplicate `rfc.validate` — it starts from the mechanical floor and goes beyond it.
- The audit does **not** assess writing style, prose quality, or formatting — only semantic and architectural correctness.
- The audit does **not** approve or reject RFCs for architecture acceptance — that is a human-only decision. The verdict is advisory.
- The audit must ground every finding in evidence: quote the RFC line, cite the DNA invariant, or reference the file path. No ungrounded assertions.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error — e.g. `write_to_file` content too long, JSON truncation, line count/character limit exceeded, or similar — do not stop and ask the user. Recover autonomously: split the content into smaller writes, use `edit`/`multi_edit`, decompose oversized files, and retry immediately. The operator's default answer to "Shall I proceed?" is always "yes".
