# Canonical Compass Header Format (v2, RFC-1094)

This is the canonical format for Compass source headers. Check the project's invariants file for the canonical Compass markup rule.

## Three-block contract

Every non-trivial source file in `apps/`, `packages/`, or `services/` must carry, in this canonical order:

1. `MODULE_CONTRACT` — describes the file's purpose and boundaries.
2. `KEY_DECISIONS` — current-state design truths (required on medium/high riskClass files, optional on low).
3. `CHANGE_SUMMARY` — compressed change history: the 5 newest governance-ID items plus a `<history>` ID tail.

Blocks out of this order are a `COMPASS-ORDER-01` violation.

## MODULE_CONTRACT

```
<MODULE_CONTRACT>
<purpose>One sentence describing what the file does.</purpose>
<non-goals>
  <item>At least one boundary the file does not cross.</item>
</non-goals>
</MODULE_CONTRACT>
```

### Rules

- `<purpose>` must be specific to this file, under 100 characters, and contain at least one file-derived token (filename stem segment, parent-directory segment for generic stems, or an exported symbol name). Boilerplate openers ("This file…", "Utility…", "TODO…") are `COMPASS-PURPOSE-01`; a purpose with no file-derived token is `COMPASS-PURPOSE-02`.
- `<non-goals>` must have at least one `<item>`.
- Do not include `@ai-invariant` lines in `MODULE_CONTRACT` — they are inline comments in the file body.

## KEY_DECISIONS

```
<KEY_DECISIONS>
  <item>Validation is deterministic regex parsing — no LLM in the check path.</item>
  <item>Warnings never fail the build during the migration window.</item>
</KEY_DECISIONS>
```

### Rules

- Content: current-state design truths of the file — invariants, chosen mechanisms, forbidden approaches. Rewritten in place when behavior changes; never appended chronologically.
- Required on files whose `riskClass` is `medium` or `high` (`COMPASS-KD-01`); optional on `low`. When present on a low-risk file, all item rules still apply.
- Limits: 1–7 `<item>` entries (`COMPASS-KD-04`), each ≤ 20 words (`COMPASS-KD-03`).
- An item MUST NOT begin with a governance-ID prefix (`RFC-`, `ADR-`, ticket pattern) — history belongs in `CHANGE_SUMMARY` (`COMPASS-KD-05`).
- An empty block or `TODO` placeholder items are a violation (`COMPASS-KD-02`).

## CHANGE_SUMMARY

```
<CHANGE_SUMMARY>
  <item>RFC-1094: adopted v2 three-block contract.</item>
  <history>RFC-0348, RFC-0349, RFC-0538</history>
</CHANGE_SUMMARY>
```

### Rules

- At most 5 `<item>` entries, each `ID: one-line description` (`COMPASS-CS-05`). The retained items are the 5 newest — the chronological tail.
- Every `<item>` MUST carry a governance ID (`RFC-XXXX`, `ADR-XXXX`, ticket pattern); items without an ID are violations (`COMPASS-CS-06`) and will be deleted by `compass.migrate` (sibling RFC, not yet implemented).
- Older IDs collapse into a single `<history>` element: comma-separated, deduplicated, per-namespace ascending numeric order (`COMPASS-CS-07`). `<history>` carries IDs only — no descriptions — and has no length cap.
- An empty `CHANGE_SUMMARY` (no items, no history) is legal for files never touched by a governance-referencing commit.

## Comment syntax by extension

See `reference/comment-styles.md` for the correct comment syntax per file extension.

## Forbidden blocks

The following legacy Compass blocks are forbidden and must be removed (`COMPASS-FORBIDDEN-01`, always an error regardless of `--mode`):

- `MODULE_MAP`, `keywords`, `responsibilities`, `COMPASS_BLOCK` — removed by RFC-0348.
- `GRACE_MODULE_CONTRACT` — use `MODULE_CONTRACT` instead.
- `GRACE_CHANGE_SUMMARY` — use `CHANGE_SUMMARY` instead.
- `AI_INVARIANTS` — use inline `// @ai-invariant` comments instead.
- `COMPASS_AUDIT` — use the audit ledger via `compass.audit.record` instead.

If `compass.validate` reports a `COMPASS-FORBIDDEN-01` violation, remove the forbidden block and run the `fo-compass-annotate` skill to generate correct headers.
