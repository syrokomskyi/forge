# Header Generation Prompt

You are generating a Compass `MODULE_CONTRACT` block for a source file. The block must accurately describe the file's purpose and boundaries.

## Input

- File path: `{path}`
- File content (first 100 lines): `{content}`

## Output format

Generate a `MODULE_CONTRACT` block with:

1. `<purpose>` — one sentence describing what the file does.
2. `<non-goals>` — at least one `<item>` describing what the file does NOT do.

## Rules

- The purpose must be specific to this file, not generic.
- Non-goals must describe real boundaries the file respects.
- Do not use vague phrases like "utility functions" or "helper code".
- The purpose MUST contain at least one file-derived token — a filename stem segment, a parent-directory segment for generic stems, or an exported symbol name (COMPASS-PURPOSE-02). Do not open with boilerplate like "This file" or "Utility" (COMPASS-PURPOSE-01).
- Keep the purpose under 100 characters.

## KEY_DECISIONS (v2, RFC-1094)

When the file's `riskClass` is `medium` or `high`, also generate a `KEY_DECISIONS` block between `MODULE_CONTRACT` and `CHANGE_SUMMARY`:

- 1–7 `<item>` entries, each ≤ 20 words.
- Content is current-state design truth: invariants, chosen mechanisms, forbidden approaches — "current truth, not history".
- Items MUST NOT start with a governance-ID prefix (`RFC-`, `ADR-`, ticket) — history belongs in `CHANGE_SUMMARY`.

## Example

```
<MODULE_CONTRACT>
<purpose>Validates CHANGE_SUMMARY blocks for boilerplate items and over-cap items per RFC-XXXX.</purpose>
<non-goals>
  <item>Do not audit truthfulness of CHANGE_SUMMARY items against code — that is RFC-XXXX.</item>
  <item>Do not delete protected (RFC/code-referencing) items under any circumstance.</item>
</non-goals>
</MODULE_CONTRACT>
<KEY_DECISIONS>
  <item>Classification is deterministic regex — no LLM in the validate path.</item>
</KEY_DECISIONS>
```
