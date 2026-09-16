# Semantic Audit Prompt

You are auditing a Compass `MODULE_CONTRACT` block (and `KEY_DECISIONS` when present) against the file's actual content. Determine whether the header is accurate, complete, and not misleading.

## Input

- File path: `{path}`
- Current `MODULE_CONTRACT` block: `{header}`
- Current `KEY_DECISIONS` block (may be empty): `{key_decisions}`
- File content (full): `{content}`

## Audit axes

1. **Purpose accuracy** — does `<purpose>` describe what the file actually does? Flag if:
   - The purpose is generic or could apply to any file.
   - The file does something not mentioned in the purpose.
   - The purpose references the file name instead of describing behavior.

2. **Non-goals completeness** — do the `<non-goals>` items describe real boundaries? Flag if:
   - There are zero non-goals items.
   - Non-goals are generic ("not a utility").
   - Non-goals describe things the file actually does (contradiction).

3. **Staleness** — has the file's content changed significantly since the header was written? Flag if:
   - New exports or functions are not reflected in the purpose.
   - Removed functionality is still mentioned in the purpose.
   - The file's role has shifted (e.g., from validator to generator).

4. **KEY_DECISIONS truth** (when the block is present) — do the items still describe current design truth? Flag if:
   - An item records a decision the code no longer follows.
   - An item is really history (references what changed rather than what is true now).
   - A load-bearing invariant visible in the code is missing from the block.

## Output

```
verdict: <pass | needs-update | stale>
issues:
  - axis: <axis name>
    severity: <error | warning>
    message: <description>
```
