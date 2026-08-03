---
name: fo-knowledge-distill
description: Distill raw knowledge logs (L0) into durable fix patterns (L1) and learned principles (L2), maintain confirmation counters, and migrate legacy sections — with operator approval on every mutation.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: []
triggers: ["distill knowledge", "compact skill knowledge", "knowledge lifecycle", "promote fix patterns"]
---

# Knowledge Distillation

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

This skill assists the operator in the knowledge distillation lifecycle: reading raw material (L0), proposing durable patterns (L1) and principles (L2), re-confirming existing entries, migrating legacy sections, and recommending compaction. Every mutation requires explicit operator approval.

## When to invoke

- **After a productive session** — when the session generated raw Q&A pairs or debugging insights that could benefit future agents.
- **When `forge.skill.knowledge.compact --all-skills --dry-run` reports legacy sections** — this skill performs the actual migration with operator approval.
- **When a SKILL-21 budget warning appears** — distill to reduce active knowledge volume.
- **When the operator asks to "distill", "compact", or "maintain" skill knowledge.**

## What this skill is NOT

- It is NOT `forge.skill.knowledge.compact` — that command handles mechanical archival (expiry, supersession, L0 retention, L2 staleness). This skill handles semantic work: grouping, promoting, and migrating.
- It is NOT `fo-session-retro` — that skill triages session discoveries and routes them. This skill works within a single skill's knowledge files.
- It is NOT `fo-extract-dna` — that skill extracts architectural invariants. This skill distills operational knowledge (fix patterns, learned principles).

## Process

### Step 1: Scope selection

Ask the operator which skill(s) to distill:

- Use `ask_user_question` to offer: (a) a specific skill by name, or (b) all skills with knowledge files.
- Parse the selected skill's knowledge files via the structured knowledge parser (in-process import of the forge `src/knowledge/` module or the `forge` package).
- Report what was found: file names, entry counts, legacy section counts, parse issues.

**Completion criteria:** operator has selected a scope and the skill has parsed all relevant knowledge files without errors.

### Step 2: Read cold material

Read L0 (`qa-log.md`) and, if present, `qa-log.archive.md`. This is the sanctioned wholesale read of the cold layer (hot/warm/cold discipline).

- Also read L1 (`fix-patterns.md`) and L2 (`learned-principles.md`) to understand existing distilled knowledge.
- Report a summary: how many raw entries, how many existing patterns/principles, what themes recur.

**Completion criteria:** all knowledge files for the selected skill have been read and summarized.

### Step 3: Propose distillations

Group recurring Q&A themes from L0. For each theme, propose either:

- An **L2 principle** (with `confirmations` seeded from observed recurrences) — for cross-cutting insights that apply broadly.
- An **L1 fix pattern** — for specific, reusable solutions to specific problems.

Present proposals as a table:

| #   | Proposed entry | Layer | Source entries | Rationale |
| --- | -------------- | ----- | -------------- | --------- |

For each proposal, use `ask_user_question` to let the operator:

- **Confirm** — the entry is written as proposed.
- **Edit** — the operator provides corrections; the entry is written with edits.
- **Drop** — the proposal is discarded.

**Completion criteria:** every proposal has been confirmed, edited, or dropped by the operator.

### Step 4: Re-confirmation pass

For existing L2 entries whose themes appear in the new material:

- Propose `confirmations + 1` and `lastConfirmedAt: today`.
- If the entry is `status: stale`, propose restoring to `status: active`.
- Present each re-confirmation individually via `ask_user_question`.

**Completion criteria:** every re-confirmation has been approved or declined by the operator.

### Step 5: Legacy migration

For each legacy section (freeform prose that predates structured entries):

- Propose a structured entry: assign an ID, set metadata (layer, created, status), preserve the body verbatim.
- Use `ask_user_question` for each legacy section — the operator approves the proposed structured entry.

**Completion criteria:** every legacy section has been migrated or explicitly skipped by the operator.

### Step 6: Write

Apply approved mutations via the knowledge serializer (`serializeKnowledgeFile`). Never string-splice markdown. Never touch entries that were not explicitly approved.

- Write files atomically (staging + rename) to prevent corruption on mid-run failure.
- Commit only the mutated knowledge files (fo-pipeline commit discipline).

**Completion criteria:** all approved mutations are written and committed.

### Step 7: Recommend compact

If retention/expiry candidates remain after distillation:

- Recommend `forge.skill.knowledge.compact --skill <name>` to the operator.
- Offer to run it via `ask_user_question`.
- If the operator declines, note it in the session summary.

**Completion criteria:** the operator has been informed of compaction opportunities and has made a decision.

### Step 8: Commit

Commit only the mutated knowledge files. Reference this skill and the knowledge lifecycle in the commit message. Do not stage unrelated changes.

**Completion criteria:** changes are committed with a descriptive message.

## Knowledge file format

All knowledge files use the structured knowledge entry format:

````markdown
<!-- knowledge-layer: L2 -->
# learned-principles.md

### K-0001: Short title

```knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
````

Body text describing the principle.

```

See `writing-great-skills` § Cumulative knowledge pattern for the three-layer reference pattern (L0 raw logs, L1 fix patterns, L2 learned principles), entry format, and mutation contract.

## Constraints

- **Operator approval on every mutation.** Never write to a knowledge file without explicit approval for each entry.
- **Serializer only.** Always use `serializeKnowledgeFile` from the forge knowledge module. Never string-splice markdown.
- **No semantic logic in command handlers.** The `forge.skill.knowledge.compact` command handles mechanical archival only. Semantic grouping and promotion live in this skill.
- **No LLM logic in `src/knowledge/`.** Deterministic planning only; meaning work lives here.
- **Read archives too.** When distilling, read both live and archive files — archived material may still contain themes worth re-distilling.

## Cross-skill promotion

When `forge.doctor` reports `knowledge-duplicate` warnings (cross-skill L2 entries with matching normalized titles), or when the operator identifies a promotion candidate, execute the promotion protocol:

### Promotion protocol

1. **Present the pair** — show both titles, bodies, confirmations, and the proposed merged shared entry (merged body, summed confirmations, `promotedFrom` provenance). The operator approves, edits, or rejects via grilling.
2. **Write the shared entry** — append to `packages/forge/skills/shared/knowledge/learned-principles.md` with the next `K-NNNN` id, `status: active`, `created: today`, `lastConfirmedAt: today`, `confirmations` (sum of sources), and `promotedFrom: ["<skill>/K-NNNN", ...]`.
3. **Rewrite local copies** — each skill-local entry keeps its heading and id but its metadata is rewritten: `promotedTo: shared/K-NNNN`, `status: superseded`; body replaced with one line: "Promoted to shared layer as shared/K-NNNN." The next compact run archives these pointer entries out of the hot file.
4. **Cite, don't copy** — future distill runs in any skill reference the shared id (`shared/K-NNNN`) instead of re-creating the principle locally.
5. **Commit** — shared file + all touched skill files in one commit.

### Promotion constraints

- **Promotion requires operator approval inside grilling** — detection is deterministic, promotion is human. Never promote without explicit operator approval for each pair.
- **Never copy shared-layer content into skill-local files** — cite via `shared/K-NNNN`, do not duplicate.
- **Never promote project-specific knowledge from pack skills into the forge shared layer** — domain-neutrality is checked during grilling. If the principle is project-specific, it stays pack-local.
- **Portability gate** — grilling must include the question: "Is this principle genuinely cross-skill, or is it specific to one skill's domain?" Only genuinely cross-skill principles promote.
```
