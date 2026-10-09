---
rfcId: RFC-0000
planId: PLAN-RFC-0000-01
status: draft
owner: architecture
createdAt: YYYY-MM-DD
updatedAt:
scope:
  apps: []
  packages: []
  services: []
  docs: []
---

# Implementation Plan: RFC-0000

## 1. Objectives

<!-- 3-7 concrete objectives tied to RFC acceptance criteria.
     Each objective should map to one or more acceptance-criteria
     checkboxes in the RFC. -->

- [ ] Objective 1 — maps to acceptance criterion [...]
- [ ] Objective 2 — maps to acceptance criterion [...]

## 2. Affected artifacts

### 2.1 Code and commands

<!-- packages/*, services/*, apps/* files.
     Site OS commands (pnpm exec werkstatt run ...).
     Registry entries, module registrations, pipeline wiring. -->

### 2.2 Configuration and data

<!-- YAML/JSON/NDJSON, system.md, manifests, biome files,
     ontology catalogs (StarCatalog, PlanetCatalog, MoonCatalog),
     content schemas, blueprints. -->

### 2.3 Documentation and specs

<!-- RFC file (read-only reference).
     AGENTS.md (root, apps/, packages/, services/).
     docs/*.xml Compass files (requirements, technology,
     development-plan, knowledge-graph, verification-plan,
     source-markup, styling).
     docs/architecture-dna.md (if new DNA invariant). -->

### 2.4 Validation and pipelines

<!-- build.check, build.prepare, apps-check, apps-check-postbuild.
     CI workflows (.github/workflows/).
     New or changed validate commands. -->

## 3. Step sequence

### Step 1. [Step title]

**Goal:** [what this step achieves]

**Agent actions:**

- [concrete action]
- [concrete action]

**Validation:**

- [command or check that confirms completion]

**Completion criterion:** [checkable condition]

**Human review:** [yes/no — if yes, what needs approval and from whom]

---

### Step 2. [Step title]

<!-- Repeat for each step. Follow the contract-first ordering:
     contracts → commands → documentation → tests → validation → evidence. -->

### Final Step. Documentation sync, review, fix, and acceptance criteria verification

**Goal:** Synchronize all documentation artifacts, run code review and fix, verify acceptance criteria, and stamp the RFC as implemented.

**Agent actions:**

- Update affected `AGENTS.md` files (root, apps/, packages/, services/) with new modules, commands, or ownership changes.
- Update affected `docs/*.xml` Compass files (requirements, technology, development-plan, knowledge-graph, verification-plan, source-markup, styling) when repository-wide semantics changed.
- Update `docs/architecture-dna.md` if a new DNA invariant was introduced.
- **Verify every file listed in `scope.docs` is updated** — check each path against `git diff`; if a scope doc was not modified, document why.
- Run `pnpm exec werkstatt run ecosystem.manifest.generate` if command surfaces or pipeline topology changed (do not hand-edit `docs/ecosystem.generated.yaml`).
- **Run code review:** invoke `fo-review` via the `skill` tool on all session code changes (`git diff <merge-base-of-session>...HEAD`). Wait for the review report in `docs/reviews/code/`.
- **Run fix if needed:** if `fo-review` reported findings, invoke `fo-fix` via the `skill` tool. Re-run `fo-review` to confirm all findings are resolved. Maximum 3 iterations.
- **Check off acceptance criteria:** verify each criterion in the RFC against the implemented code. Mark `[x]` for verified criteria. For unchecked `[ ]` criteria, document why (e.g. "requires runtime command blocked by environment").
- **Stamp the RFC as implemented:** run `pnpm exec werkstatt run rfc.implement.stamp --id RFC-XXXX --implementation-commit <sha>` to atomically transition `accepted → implemented` (RFC-0476). The command validates all preconditions (status, criteria, clean tree, commit reachability). Do NOT hand-edit `status`, `implementedAt`, or `closedAt` fields — use the command.

**Validation:**

- `git status` — no uncommitted changes from the current session.
- `pnpm exec werkstatt run rfc.validate --id RFC-XXXX`
- Every file in `scope.docs` is either updated or documented as not-applicable.
- Review report exists in `docs/reviews/code/` for this session.

**Completion criterion:** All documentation artifacts in scope are updated; code review passed (findings fixed if any); all acceptance criteria are checked off with inline `(evidence: ...)` annotations; RFC is stamped as `implemented` via `rfc.implement.stamp`.

**Human review:** no — the `accepted → implemented` transition is automated via `rfc.implement.stamp` (RFC-0476), which validates all preconditions atomically. Code review is automated via `fo-review`.

## 4. Validation suite

### 4.1 Required checks

<!-- Commands that must pass before stamping implemented (RFC-0224). -->

- `pnpm exec werkstatt run rfc.validate --id RFC-XXXX`
- `pnpm --filter <package> run build:check`
- `pnpm exec werkstatt run rfc.acceptance.run --id RFC-XXXX` (if acceptance probes declared)
- `pnpm exec werkstatt run rfc.verification.emit --id RFC-XXXX` (RFC-0330, for probe-bearing RFCs created on or after 2026-07-07)

### 4.2 Evidence artifacts

<!-- What to commit alongside the implemented status. -->

- `docs/rfcs/verification/rfc-xxxx.generated.json` — verification evidence (RFC-0330)
- Commit messages referencing `RFC-XXXX` in the subject line (RFC-0265 commit hygiene)

## 5. Risks and mitigation

<!-- Map each risk from the RFC's Risks section to specific plan
     steps that control it. -->

| Risk (from RFC) | Mitigation (plan step)   |
| --------------- | ------------------------ |
| [risk text]     | [how step N controls it] |

## 6. Escalation triggers

<!-- Conditions that should trigger rfc.supersede.propose (RFC-0334)
     instead of working around an invariant conflict. -->

- If implementation reveals an invariant conflict with DNA-N, run `pnpm exec werkstatt run rfc.supersede.propose --id RFC-XXXX --reason "..." --invariant "DNA-N"` instead of working around it.

## Falsified routes

<!-- Negative-knowledge ledger — append a row whenever an approach is
     abandoned after a real attempt. Consult before proposing alternatives;
     "yes" rows reject matching proposals without a stated new fact.
     Rows are never deleted — superseded rows get a revivedAt annotation. -->

| Route | Root cause | Falsified at | Forbidden retry |
| ----- | ---------- | ------------ | --------------- |
