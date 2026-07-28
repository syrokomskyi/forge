---
name: fo-extract-dna
description: Discover implicit architectural invariants, grill the operator about each, and delegate to fo-idea-create-rfc. After acceptance, append to architecture-dna.md. Use when extracting DNA.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [commands.validateRfc]
  optional: [paths.invariantsFile]
triggers: ["extract DNA invariant", "discover architectural invariants", "formalize implicit architectural rules"]
---

# Extract DNA

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

> **This is a document-only skill.** It produces RFC files in `docs/rfcs/` and, after RFC acceptance, appends entries to `docs/architecture-dna.md` — nothing else. It must never modify, create, or delete source code files in `apps/`, `packages/`, `services/`, or any other directory. It must not run build commands, tests, or validation suites other than `rfc.validate`, `dna.registry.validate`, and `rfc.dna.trace.validate`. Implementation of the RFC's code changes is handled by `fo-idea-implement` after the RFC is accepted.

## Purpose

The codebase contains **implicit architectural invariants** — rules that developers and agents consistently follow but that have never been formally recorded in `ref(forge.yaml bindings.paths.invariantsFile)`. These are DNA candidates waiting to be discovered and formalized.

This skill is the **discovery entry point**: it scans the codebase or listens to the operator's description, identifies patterns that look like stable invariants, grills the operator about each one, and — at agreement — routes through the normal RFC governance pipeline to establish them formally.

**What this skill is NOT:**

- It is not a shortcut that bypasses RFC acceptance. DNA entries are appended to the registry **only after** the establishing RFC is accepted.
- It is not a bulk scanner that auto-generates DNA. Every candidate requires operator discussion and explicit agreement.
- It is not a replacement for `fo-idea`. `fo-idea` starts from an operator's idea and routes to RFC/ADR. `fo-extract-dna` starts from **codebase patterns** or **operator-described conventions** and routes to RFC with a DNA-establishment focus.

## Process

### 1. Identify the discovery mode

The operator may trigger this skill in one of two modes:

- **Codebase scan mode** — "find implicit DNA in the codebase", "what invariants exist but aren't recorded", "scan for architectural patterns". The skill scans the codebase to discover candidates.
- **Convention description mode** — the operator describes a convention they follow ("we always do X", "components must never do Y", "all Z goes through W"). The skill evaluates whether this is a DNA-grade invariant.

If the operator's request is ambiguous, ask using `ask_user_question`:

> "Should I scan the codebase for implicit invariants, or do you have a specific convention in mind to evaluate?"

### 2. Read the existing DNA registry

Before proposing any candidate, read `ref(forge.yaml bindings.paths.invariantsFile)` in full. Record:

- All existing `DNA-N` ids and their titles (to avoid duplicates).
- The next available `DNA-N` number (max existing + 1).
- Which invariants are marked "Foundational invariant (pre-RFC)" vs "Established by RFC-XXXX".
- Which invariants have been "Reclassified to feature".

Also read the RFC template (`os/rfc/rfc-0000-template.md` inside `@warpgogol/forge`) to understand the `satisfies` field and the "DNA-N established by this RFC" marker pattern.

### 3. Discover DNA candidates

#### 3a. Codebase scan mode

Scan the codebase for patterns that **look like stable invariants but are not yet recorded**. Look for:

- **Structural conventions** — directory layouts, file naming, import boundaries that are consistently followed across `apps/*` and `packages/*`.
- **Code patterns** — repeated type signatures, consistent error handling shapes, uniform export patterns across packages.
- **Enforcement gaps** — conventions that have a lint/check command but no DNA entry documenting the invariant.
- **Cross-workspace contracts** — interfaces or schemas shared between packages that are treated as stable but never formalized.
- **Negative space** — things that are **never done** (e.g. "no app imports from another app" was DNA-1 before it was recorded).

For each candidate, check:

1. Is this already covered by an existing DNA-N? If yes, skip.
2. Is this a **stable invariant** (not a temporary convention or migration-period rule)?
3. Is this **enforceable** — could a Site OS command check it, or is it a documentation-only rule?
4. Is this **cross-workspace** (applies to multiple apps/packages, not just one)?

Present candidates as a numbered list with a one-line summary each. Do not propose more than 5 candidates in one batch — the operator needs to discuss each.

#### 3b. Convention description mode

Take the operator's description and evaluate it against the DNA criteria:

- Is the convention **stable** (followed consistently, not in flux)?
- Is it **cross-workspace** (not local to one package/app)?
- Does it **warrant DNA status** (permanent, not a feature or product decision)?
- Is it **enforceable** (can a command verify it)?
- Is it already covered by an existing DNA-N?

If the convention is local, temporary, or a product decision, explain why it is not DNA-grade and suggest an ADR instead.

### 4. Grill each candidate

For each DNA candidate that the operator agrees to pursue, invoke the `/grilling` skill to stress-test it. The grilling examines:

- **Formulation** — is the invariant stated precisely enough to be checkable? Vague formulations like "code should be clean" are not DNA-grade.
- **Scope** — is this truly cross-workspace, or is it local to one package/app? Local invariants are ADRs, not DNA.
- **Enforcement** — what Site OS command would enforce this? If no command exists and none is planned, is this really an invariant or just a convention?
- **Stability** — is this a temporary rule during a migration? DNA invariants are permanent until superseded by another RFC.
- **Overlap** — does this overlap with or contradict an existing DNA-N? If it extends or refines an existing one, the RFC should amend the original, not create a parallel entry.
- **Cost of violation** — what breaks if this invariant is violated? If nothing breaks, it is not an invariant.
- **Agent clarity** — will an AI agent understand this invariant from the DNA entry alone, without reading the RFC? DNA entries are referenced by agents who may not read the full RFC.

Address every concern the grilling raises by adjusting the formulation, scope, or enforcement plan. Do not proceed to RFC creation until the grilling is satisfied with the candidate.

### 5. Present the DNA candidate summary

After grilling, present a structured summary for each candidate:

```
## DNA Candidate: DNA-<N> · <Title>

**Formulation:** <one-sentence invariant statement, present tense>
**Scope:** workspace | package
**Enforcement:** <Site OS command name> or "documentation-only (no command)"
**Established by:** RFC-XXXX (to be created)
**Cost of violation:** <what breaks>
**Related DNA:** <existing DNA-N that this extends, refines, or complements>
**Grilling verdict:** passed | adjusted | rejected
```

Ask the operator to confirm or adjust using `ask_user_question`. Do not proceed to RFC creation until the operator explicitly confirms each candidate.

### 6. Delegate to fo-idea-create-rfc

For each confirmed DNA candidate, invoke `/fo-idea-create-rfc` **inline** with the following specifics:

- **title** — the DNA candidate title (imperative sentence).
- **kind** — `architecture` (DNA-establishing RFCs are always architecture kind).
- **scope** — `workspace` (DNA invariants are cross-workspace by definition).
- **satisfies** — leave empty; this RFC **establishes** a new DNA, it does not satisfy an existing one.
- **In the RFC body**, ensure the "Architectural fit" section contains the canonical marker:

  ```
  DNA-<N> established by this RFC.
  ```

  This marker is what `dna.registry.validate` (DNA-REG-03 rule) scans for. Without it, the registry guard will not flag the missing entry.

- **In the "Design" section**, include the proposed DNA registry entry text:

  ```markdown
  ## DNA-<N> · <Title>

  <One-paragraph invariant description. Present tense, stating the rule as fact.>
  Enforced by `<command.name>`. Established by RFC-XXXX.
  ```

  If the invariant is foundational (pre-RFC, already followed but never recorded), use:

  ```markdown
  Foundational invariant (pre-RFC). Enforced by `<command.name>`.
  ```

  If no command enforces it yet, the RFC must either:
  - Propose a new command (making this a command-kind RFC in addition to architecture), or
  - Explicitly state that enforcement is documentation-only and explain why that is acceptable for this invariant.

Let the creation skill run fully — it will grill, create the file, fill all sections, validate, and report. Do not duplicate its work.

### 7. Report after RFC creation

After the RFC is created, present:

```
## DNA Extraction Summary

### Candidates discovered: <N>
### Candidates confirmed: <M>
### RFCs created: <K>

| # | DNA ID | Title | RFC | Status |
| --- | --- | --- | --- | --- |
| 1 | DNA-<N> | <title> | RFC-XXXX | draft |

### Next steps
- Human architecture review for each RFC draft (status may not change before acceptance).
- After acceptance: run /fo-extract-dna --register to append DNA entries to `ref(forge.yaml bindings.paths.invariantsFile)`.
```

**Do not append to `ref(forge.yaml bindings.paths.invariantsFile)` while the RFC is in `draft` status.** The DNA registry entry is added only after the RFC is accepted.

### 8. Post-acceptance registration (separate invocation)

When the operator invokes this skill with `--register` (or says "register DNA", "append DNA", "the RFC was accepted"), perform the registration step:

1. **Verify RFC status** — read the RFC frontmatter. If `status` is not `accepted` or `implemented`, stop with:

   > "RFC-XXXX is `draft`. DNA entries may only be appended to the registry after the RFC is accepted. Run the skill again after architecture review."

2. **Read the current registry** — parse `ref(forge.yaml bindings.paths.invariantsFile)` to find the max DNA-N number and confirm the new DNA-N is not already present.

3. **Append the entry** — add the `## DNA-<N> · <Title>` block at the **bottom** of `ref(forge.yaml bindings.paths.invariantsFile)`, using the text from the RFC's Design section. The entry must include:
   - The invariant description (present tense, as fact).
   - `Enforced by \`<command>\`.` (if a command exists or is proposed).
   - `Established by RFC-XXXX.` (the accepting RFC id).

4. **Validate** — run:

   ```sh
   ref(forge.yaml bindings.commands.validateRfc) --dna.registry.validate --json
   ```

   Fix any violations. Common issues:
   - DNA-REG-01: gap in numbering (entries must be contiguous from 1).
   - DNA-REG-02: citation points to a non-existent RFC.
   - DNA-REG-03: RFC says "DNA-N established by this RFC" but registry has no entry (this should now be resolved).
   - DNA-REG-05: enforcer command is not registered or not pipelined.

5. **Run DNA trace validation** — run:

   ```sh
   ref(forge.yaml bindings.commands.validateRfc) --dna.trace.validate --json
   ```

   This verifies the bidirectional trace between the new DNA entry and the RFC's `satisfies` field.

6. **Commit** — stage only `ref(forge.yaml bindings.paths.invariantsFile)` and commit:

   ```txt
   dna: register DNA-<N> <short title>

   Append DNA-<N> (<title>) to the canonical registry, established by RFC-XXXX.
   ```

   Stage only `ref(forge.yaml bindings.paths.invariantsFile)` — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

7. **Report**:

   ```
   DNA-<N> registered in `ref(forge.yaml bindings.paths.invariantsFile)`
   Established by: RFC-XXXX
   Enforced by: <command> (or: documentation-only)
   dna.registry.validate: pass
   rfc.dna.trace.validate: pass
   ```

## Constraints

- **Document-only. This skill must never modify, create, or delete source code files.** It must not touch files in `apps/`, `packages/`, `services/`, `tools/`, `scripts/`, or any other source directory. The only files this skill may produce or modify are RFC files in `docs/rfcs/` (via the delegated `fo-idea-create-rfc` skill) and `docs/architecture-dna.md` (during the post-acceptance registration step). If you feel the urge to "quickly implement the enforcer command while I'm here" — stop. That is not this skill's job.
- **No bypass of RFC acceptance.** DNA entries are appended to `ref(forge.yaml bindings.paths.invariantsFile)` only after the establishing RFC is `accepted` or `implemented`. The skill must verify RFC status before appending. Draft RFCs do not register DNA.
- **Grilling is mandatory for every candidate.** Do not skip step 4 — every DNA candidate must survive grilling before an RFC is created. The operator's verbal agreement is necessary but not sufficient; the grilling may reveal formulation, scope, or enforcement problems that the operator had not considered.
- **Operator confirmation is mandatory before RFC creation.** Do not create an RFC for a candidate the operator has not explicitly confirmed. Use `ask_user_question` in step 5.
- **One RFC per DNA candidate.** If multiple candidates are confirmed, each gets its own RFC. Do not bundle multiple DNA invariants into a single RFC — each invariant must be independently reviewable, acceptable, and supersedeable.
- **Do not append to `ref(forge.yaml bindings.paths.invariantsFile)` directly during RFC creation.** The registration step (step 8) is a separate invocation, performed after the RFC is accepted. This separation preserves the human review gate.
- **Do not renumber or delete existing DNA entries.** The registry header says "Agents MUST NOT delete or renumber items; add new entries only at the bottom." This is a non-negotiable rule from `ref(forge.yaml bindings.paths.invariantsFile)`.
- **Do not create DNA entries for features or product decisions.** DNA invariants are architectural rules. Features are governed by RFCs but recorded as features (see DNA-27..34 reclassification by RFC-XXXX). If a candidate is a feature, suggest an RFC without a DNA entry.
- **Do not create DNA entries for local conventions.** If a convention is local to one package or one app, it is an ADR, not DNA. Route to `fo-idea-create-adr` instead.
- **Commit only your own files.** Stage only the files this skill produces or modifies — RFC files, `ref(forge.yaml bindings.paths.invariantsFile)`, and nothing else. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
- **The canonical marker phrase is load-bearing.** The RFC body must contain exactly `DNA-<N> established by this RFC` (with the correct number) so that `dna.registry.validate` DNA-REG-03 rule can detect it. Do not paraphrase this phrase.
