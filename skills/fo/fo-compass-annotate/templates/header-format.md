# Canonical Compass Header Format

This is the canonical format for Compass source headers (DNA-42, RFC-XXXX, RFC-XXXX).

## Two-block contract

Every non-trivial source file in `apps/`, `packages/`, or `services/` must carry:

1. `MODULE_CONTRACT` — describes the file's purpose and boundaries.
2. `CHANGE_SUMMARY` — chronological list of changes with RFC/ticket references.

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

- `<purpose>` must be specific to this file, under 100 characters.
- `<non-goals>` must have at least one `<item>`.
- Do not include `@ai-invariant` lines in `MODULE_CONTRACT` — they are inline comments in the file body.

## CHANGE_SUMMARY

```
<CHANGE_SUMMARY>
  <item>RFC-XXXX: one-line description of the change.</item>
</CHANGE_SUMMARY>
```

### Rules

- Each `<item>` should reference an RFC id, ticket id, or ADR id (protected items).
- Items without an RFC/ticket reference are "unprotected" and may be trimmed by `compass.summary.trim`.
- Maximum 30 total items per file (enforced by `compass.changesummary.validate`).
- Boilerplate items (e.g., "Initial creation", "Compass scaffolding") are automatically removed by `compass.summary.trim`.

## Comment syntax by extension

See `reference/comment-styles.md` for the correct comment syntax per file extension.

## Forbidden blocks

The following legacy Compass blocks are forbidden and must be removed:

- `GRACE_MODULE_CONTRACT` — use `MODULE_CONTRACT` instead.
- `GRACE_CHANGE_SUMMARY` — use `CHANGE_SUMMARY` instead.
- `AI_INVARIANTS` — use inline `// @ai-invariant` comments instead.
- `COMPASS_AUDIT` — use the audit ledger via `compass.audit.record` instead.

If `compass.validate` reports a `COMPASS-FORBIDDEN-01` violation, remove the forbidden block and run the `fo-compass-annotate` skill to generate correct headers.
