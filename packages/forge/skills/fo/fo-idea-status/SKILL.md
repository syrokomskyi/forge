---
name: fo-idea-status
description: Show a concise table of RFCs and ADRs filtered by status or mentioned in the current session. Use when the operator wants a quick status overview.
invocation: user
category: fo
concerns: read-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [commands.validateRfc, commands.validateAdr]
triggers: ["show RFC and ADR status", "what is the status of this RFC", "list RFCs by status"]
---

# RFC and ADR Status

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

See `_shared/fo-pipeline-conventions.md` §Language policy.

## What this skill does

Lists RFCs and ADRs via site-kernel commands (or by scanning frontmatter as fallback), collects statuses, and presents a concise table. If the operator specifies statuses, filter to those. If the operator mentions RFC/ADR ids in the invocation, include those regardless of status. When a single status has more than 12 documents, show only the count instead of listing each one.

## Process

### 1. Determine the filter

Check the operator's input for:

- **Status names** — `draft`, `accepted`, `implemented`, `reviewing`, `rejected`, `superseded`, `retired`. If provided, filter to those statuses only.
- **No filter** — if no statuses are specified, show all statuses that have at least one document.
- **Session mentions** — if the operator included `RFC-XXXX` or `ADR-XXXX` ids in the current invocation, always include those documents in the output, even if their status was not requested.

### 2. Collect documents

**Always** make a single call to `rfc.list --json` (no `--status` flag) and a single call to `adr.list --json`. Filter by status in memory from the returned `entries` array. Never make per-status calls.

```sh
ref(forge.yaml bindings.commands.validateRfc) --list --json
ref(forge.yaml bindings.commands.validateAdr) --list --json
```

If `adr.list` is not available, fall back to scanning `docs/adrs/adr-*.md` frontmatter.

Read the JSON output and extract `id`, `title`, `status`, `createdAt`, and `updatedAt` from each entry.

### 3. Build the table

Sort entries by `updatedAt` descending (newest first). If `updatedAt` is missing or equal, fall back to `createdAt` descending.

Group documents by type (RFC, ADR) and then by status. **Translate all headings and column names to `aiLanguage`** — the templates below are structural only. For each group:

- If the group has **≤12 documents**, list each one: `| ID | Title | Status |`
- If the group has **>12 documents**, show only the count

For counts-only groups:

```
## RFC Status

| Status | Count |
| --- | --- |
| implemented | 328 |
| draft | 7 |

(Showing counts for implemented; listing draft individually.)
```

If all requested groups are small enough, use the detailed table per type:

```
## RFC Status

| ID | Title | Status |
| --- | --- | --- |
| RFC-XXXX | ... | draft |
...
```

### 4. Session mentions

If the operator mentioned specific RFC/ADR ids in the invocation, add a section after the tables:

```
### Mentioned in this session

| ID | Title | Status |
| --- | --- | --- |
| RFC-XXXX | ... | draft |
```

### 5. Stop

Present the table and stop. This skill is read-only — it does not modify any file.

## Constraints

- **Read-only.** This skill does not modify any file.
- **Concise output.** Use the >12 threshold to keep output manageable. Show counts, not individual listings, for large groups.
- **Include session mentions.** Always include documents the operator mentioned in the invocation, regardless of the status filter.
- **Prefer OS commands.** Use `rfc.list`/`adr.list` instead of scanning the file system.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
