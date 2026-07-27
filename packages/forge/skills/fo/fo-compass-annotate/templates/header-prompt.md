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
- Do not reference the file name in the purpose.
- Keep the purpose under 100 characters.

## Example

```
<MODULE_CONTRACT>
<purpose>Validates CHANGE_SUMMARY blocks for boilerplate items and over-cap items per RFC-XXXX.</purpose>
<non-goals>
  <item>Do not audit truthfulness of CHANGE_SUMMARY items against code — that is RFC-XXXX.</item>
  <item>Do not delete protected (RFC/code-referencing) items under any circumstance.</item>
</non-goals>
</MODULE_CONTRACT>
```
