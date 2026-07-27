---
name: fo-handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Saves to OS temp directory, not the workspace.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggers: ["create a handoff document", "compact conversation for next agent", "prepare handoff for another agent"]
---

# fo-handoff

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the temporary directory of the user's OS — not the current workspace.

## Process

### 1. Gather context

Review the current conversation to identify:

- What was being worked on
- What was completed
- What remains to be done
- Any blockers, open questions, or decisions pending

### 2. Write the handoff document

Include:

- **Suggested skills** — which skills the next agent should invoke and why.
- **References to existing artifacts** — specs, plans, ADRs, issues, commits, diffs. Reference them by path or URL instead of duplicating content.
- **Current state** — what the codebase looks like now, what's uncommitted, what's in progress.
- **Next steps** — concrete, actionable items the next agent should pick up.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

### 3. Save

Save to the OS temporary directory — not the current workspace. On Windows, use `$env:TEMP`. On macOS/Linux, use `/tmp`.

If the operator passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

### 4. Report

Tell the operator the absolute path of the handoff document and suggest opening a fresh session that references it.

## Constraints

- **Do not save to the workspace.** The handoff document goes to the OS temp directory.
- **Do not duplicate existing artifacts.** Reference them by path or URL.
- **Redact sensitive information.** API keys, passwords, PII.
- **Commit only your own files.** This skill does not commit anything — the handoff doc is in the temp directory. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
