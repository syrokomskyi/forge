<!-- L1: Baseline fix patterns for filtering, deduplication, and import decisions.
     Grown by AI per operator direction. Each pattern describes a recurring situation
     and the action to take. -->
<!-- knowledge-layer: L1 -->

# Fix Patterns

### K-0001: Skip non-project sessions

```knowledge-entry
id: K-0001
layer: L1
created: 2026-08-03
status: active
```

**Situation:** Codex session references a project path that does not match the current project root or git remote.

**Action:** Skip. List in the "Filtered out" section of the report with reason "irrelevant — references different project".

### K-0002: Skip duplicate knowledge

```knowledge-entry
id: K-0002
layer: L1
created: 2026-08-03
status: active
```

**Situation:** Memory or session content is already present in `AGENTS.md`, `docs/architecture-dna.md`, or existing `docs/sessions/` files.

**Action:** Skip import. List in the "Filtered out" section with reason "duplicate — knowledge already in <location>".

### K-0003: Import project convention

```knowledge-entry
id: K-0003
layer: L1
created: 2026-08-03
status: active
```

**Situation:** Memory or instruction contains a convention or rule directly applicable to the current project.

**Action:** Route to the nearest applicable `AGENTS.md`. Read the file before editing. Add in concise actionable form.

### K-0004: Redact sensitive information

```knowledge-entry
id: K-0004
layer: L1
created: 2026-08-03
status: active
```

**Situation:** Memory or session content contains API keys, passwords, or PII.

**Action:** Redact before importing. Replace with `<redacted>` placeholder. Never import raw secrets.
