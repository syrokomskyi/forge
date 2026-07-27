# Semantic Audit Prompt

You are auditing a Compass `MODULE_CONTRACT` block against the file's actual content. Determine whether the header is accurate, complete, and not misleading.

## Input

- File path: `{path}`
- Current `MODULE_CONTRACT` block: `{header}`
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

## Output

```
verdict: <pass | needs-update | stale>
issues:
  - axis: <axis name>
    severity: <error | warning>
    message: <description>
```
