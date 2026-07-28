<!-- L1: Baseline fix patterns for filtering, deduplication, and import decisions.
     Grown by AI per operator direction. Each pattern describes a recurring situation
     and the action to take. -->
# Fix Patterns

## Pattern A: Skip non-project sessions

**Situation:** Codex session references a project path that does not match the current project root or git remote.
**Action:** Skip. List in the "Filtered out" section of the report with reason "irrelevant — references different project".

## Pattern B: Skip duplicate knowledge

**Situation:** Memory or session content is already present in `AGENTS.md`, `docs/architecture-dna.md`, or existing `docs/sessions/` files.
**Action:** Skip import. List in the "Filtered out" section with reason "duplicate — knowledge already in <location>".

## Pattern C: Import project convention

**Situation:** Memory or instruction contains a convention or rule directly applicable to the current project.
**Action:** Route to the nearest applicable `AGENTS.md`. Read the file before editing. Add in concise actionable form.

## Pattern D: Redact sensitive information

**Situation:** Memory or session content contains API keys, passwords, or PII.
**Action:** Redact before importing. Replace with `<redacted>` placeholder. Never import raw secrets.
