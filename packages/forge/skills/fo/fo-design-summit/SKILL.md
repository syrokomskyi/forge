---
name: fo-design-summit
description: Simulate a multi-persona design discussion for complex RFCs. Each persona reviews from its professional perspective and raises concerns. Optional, invoked for high-risk architectural RFCs.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'fo-idea-audit']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [paths.invariantsFile]
  optional: []
triggers: ["design summit", "multi-persona review", "party mode"]
---

# Design Summit

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

See `_shared/fo-pipeline-conventions.md` §Language policy.

A multi-persona design review for complex RFCs. The summit simulates five professional perspectives — Architect, Security Engineer, QA Engineer, Product Manager, and Developer Advocate — to surface issues that a single-perspective review misses. Each persona reviews the RFC from its professional lens and raises concerns. The operator sees all perspectives and makes the final decision.

The summit is **optional** — invoked manually by the operator or suggested by `fo-idea-plan` for RFCs that meet complexity criteria. It is not part of the default pipeline.

The summit is `concern: document-only` — it writes a summit report to `docs/summits/` and does not modify the RFC or any source code.

## Process

### 1. Identify the RFC

The user may provide:

- **A single RFC**: `RFC-XXXX`, a filename, or a path.
- **Nothing**: if an RFC file is open in the IDE, use it. Otherwise, ask.

### 2. Prerequisite checks

Before running the summit, perform these checks **in order**:

1. **Prefix check** — if the id starts with `ADR-`, stop with message: `ADR-XXXX is an ADR. Design summits are for RFCs only. ADRs use the accepted-decision fast path.`
2. **RFC file exists** — look for `docs/rfcs/rfc-XXXX-*.md`. If no file is found, stop with message: `RFC-XXXX not found in docs/rfcs/.`
3. **Terminal status check** — read the RFC's `status` frontmatter. If the status is `implemented`, `rejected`, or `superseded`, stop with message: `RFC-XXXX is <status> (terminal). Terminal RFCs cannot be reviewed in a summit.`

If all checks pass, proceed to step 3.

### 3. Read the RFC and related context

Read the target RFC file and its related context:

- `ref(forge.yaml bindings.paths.invariantsFile)` — all DNA invariants referenced in the RFC's `satisfies[]` or `related[]`.
- Each RFC listed in `amends[]`, `supersedes[]`, `related[]` — read enough to understand what this RFC builds on or changes.
- The closest `AGENTS.md` for the RFC's scope.

### 4. Read the audit report (if available)

Look for `docs/audits/audit-rfc-XXXX-*.md`. If an audit report exists, read it to avoid duplicating findings. The summit complements the audit — it does not repeat it.

If no audit report exists, proceed without it. Note this in the summit report: persona findings may overlap with future audit findings.

### 5. Run each persona

For each of the five personas, the agent:

1. Adopts the persona's perspective and review focus.
2. Reads the RFC from that perspective.
3. Produces a persona report with findings (concerns, questions, recommendations).

#### Persona: Architect

**Focus:** Structural integrity, DNA alignment, coupling.

**Key questions:**

- Does this create hidden dependencies between packages or services?
- Which DNA invariants are affected? Does the RFC explain how it enforces or protects each one?
- Will this decision be reversible? If not, is the irreversibility justified?
- Does the RFC propose a new package, command, or lifecycle that could be a flag on an existing one?

#### Persona: Security Engineer

**Focus:** Attack surface, data exposure, trust boundaries.

**Key questions:**

- What new trust boundaries does this create?
- Are there unauthenticated paths to sensitive data?
- Does this leak sensitive data in logs, error messages, or generated artifacts?
- If the RFC touches persistence, does it introduce cookies or client-side storage outside the established policy?

#### Persona: QA Engineer

**Focus:** Testability, failure modes, edge cases.

**Key questions:**

- How do we test this? What is the test seam — unit, integration, or both?
- What are the failure modes? What happens under partial failure?
- Does the RFC consider empty states (new app with no content, package with no manifests)?
- Are acceptance criteria checkable by an agent or human?

#### Persona: Product Manager

**Focus:** User impact, rollout risk, scope.

**Key questions:**

- Does this solve the stated problem? Is the problem statement grounded in a real user need?
- What is the rollout impact on existing users? Is there a migration path?
- Is the scope right — too broad, too narrow, or correctly bounded?
- Are `nonGoals` explicit and meaningful?

#### Persona: Developer Advocate

**Focus:** Agent clarity, onboarding, documentation.

**Key questions:**

- Can a new agent understand and implement this RFC without external context?
- Is the RFC self-contained, or does it reference implicit assumptions?
- Are there terms or concepts that need a glossary entry?
- Does the RFC's `Implementation notes for agents` section provide explicit behavioral rules?

### 6. Synthesize

Present all persona reports in a single summit document, highlighting:

- **Consensus findings** — concerns raised by 2+ personas (high priority).
- **Unique findings** — concerns raised by a single persona (medium priority).
- **No concerns** — personas that found no issues (confidence signal).

Deduplicate overlapping concerns. When two personas raise the same issue from different angles, merge them into a consensus finding.

### 7. Persist the summit report

Write `docs/summits/summit-<rfc-id>.md` with the full discussion.

#### Summit report format

```markdown
---
rfc: RFC-XXXX
createdAt: YYYY-MM-DD
personas: [architect, security, qa, pm, dev-advocate]
consensusFindings: <count>
uniqueFindings: <count>
---

# Design Summit: RFC-XXXX

## Architect

### Findings
- **A1 (concern):** <finding text>
- **A2 (question):** <finding text>

### No concerns
- <what the architect found well-designed>

## Security Engineer

### Findings
- **S1 (concern):** <finding text>

## QA Engineer

### Findings
- **Q1 (concern):** <finding text>

## Product Manager

### Findings
- **P1 (concern):** <finding text>

## Developer Advocate

### Findings
- **D1 (question):** <finding text>

## Consensus findings

- **A1 + D1 (2 personas):** <merged finding and recommendation>

## Recommendation

<proceed to acceptance | revise the RFC | run fo-explore for unresolved questions>
```

The report must include the disclaimer: "No findings does not mean no issues — it means no issues were found from these five perspectives."

### 8. Suggest actions

Recommend whether to:

- **Proceed to acceptance** — if no consensus findings and unique findings are minor.
- **Revise the RFC** — if consensus findings or significant unique findings exist. Route through `fo-idea-enhance` as audit-style findings.
- **Run `fo-explore`** — if unresolved questions require deeper exploration before revision.

### 9. Commit

Commit the summit report. This is **mandatory** — the report must be committed, not left in the working tree.

Commit message format:

```txt
summit: RFC-XXXX <short description>

Multi-persona design summit for RFC-XXXX (<title>). <count> consensus findings, <count> unique findings.
```

Stage only the summit report file — do not stage unrelated changes.

### 10. Stop

Do not modify the RFC or any other file. Do not run `/fo-idea-enhance` or `/fo-idea-plan` — those are separate skills. Present the summit report and stop. If the user asks to fix findings, suggest running `/fo-idea-enhance`.

## Invocation criteria

`fo-design-summit` is invoked explicitly by the operator or suggested by `fo-idea-plan` when the RFC meets **any** of these criteria:

- `kind: architecture` AND `scope: workspace`
- `satisfies[]` includes 2+ DNA invariants
- The RFC introduces a new package, new command family, or new lifecycle
- The RFC supersedes an implemented RFC
- The operator explicitly requests it

## Failure modes

- **RFC not found:** The skill errors if the target RFC does not exist.
- **Audit not run yet:** The skill proceeds without the audit report — persona findings may overlap with future audit findings. The skill notes this in the report.
- **RFC is too small for a summit:** If the RFC body is less than 500 words, the skill warns that a summit may be overkill and proceeds only if the operator confirms.
- **Persona findings overlap:** Multiple personas may raise the same concern. The synthesis step deduplicates and marks consensus findings.

## Constraints

- The summit is `concern: document-only` — it must not modify the RFC, source code, or any file except the summit report in `docs/summits/`.
- **Commit only your own files.** Stage only the summit report. Do not stage unrelated changes. `git add -A` or `git add .` is forbidden.
- Personas are **simulated** by a single agent in one session. This is not multi-agent infrastructure. Each persona is a perspective shift, not a separate process.
- The summit report is an informational artifact, not a governance document. It does not block RFC acceptance — the operator decides whether to act on its findings.
- Summit findings that warrant RFC changes should be routed through `fo-idea-enhance` as audit-style findings, not applied directly by the summit skill.
- **No pauses for recoverable tool errors.** If a tool call fails with a recoverable error, recover autonomously: split content into smaller writes, use `edit`/`multi_edit`, and retry immediately.
