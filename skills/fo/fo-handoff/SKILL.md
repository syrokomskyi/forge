---
name: fo-handoff
description: Compact the current conversation into a handoff document for another agent to pick up. Saves to docs/handoffs/ (resolved from forge.yaml paths.handoffsDir) and commits via ecosystem.commit.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["create a handoff document", "compact conversation for next agent", "prepare handoff for another agent"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-handoff skill — Compact the current conversation into a handoff document for another agent to pick up. Saves to docs/handoffs/ (resolved from forge.yaml paths.handoffsDir) and commits via ecosystem.commit.</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — SKILL.md headers + classification fixes

Sweep batch 1: add Compass v2 headers to 45 SKILL.md files (purpose derived from frontmatter description). Fix non-skill-markdown exclusion to check filename not workspace-relative path (packages/AGENTS.md escaped it). Add .coverage to ignoredDirs.</item>
</CHANGE_SUMMARY>
-->

# fo-handoff

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Write a handoff document summarising the current conversation so a fresh agent can continue the work. Save to the project's handoffs directory (resolved from `forge.yaml` `paths.handoffsDir`, defaulting to `docs/handoffs/`), not the OS temp directory.

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
- **System State Transition** — three prose subsections:
  - **Before** — state N before the session (what the system looked like before changes)
  - **Change** — what was done (the key changes made during the session)
  - **After** — state N+1 after the session (what the system looks like now)
- **Resulting Architecture** — optional Mermaid diagram of the system state AFTER changes, following the diagram selection rules from `_shared/fo-session-summary.md`. If no diagram is warranted, state: "No diagram: this session did not change system structure."
- **Unclosed items** — mandatory tri-state list of open items, each `{ item, state: closed | unclosed | undecidable }`, or an explicit "none". An item absent from the list is treated as `undecidable` — absence is never read as success. If three or more entries would be `undecidable`, escalate to the operator instead of writing the handoff. See `_shared/fo-pipeline-conventions.md` §Tri-state closure marking.
- **Continuation entry point** — mandatory: the exact file, command, or skill the next agent starts from (e.g. `docs/plans/plan-rfc-xxxx.md` step 3, `werkstatt run <command>`, `/fo-fix`). Never leave the re-entry point implicit.
- **Next steps** — concrete, actionable items the next agent should pick up.
- **Memory layer pointer** — tell the next agent to read `.agents/memory/MEMORY.md` and recent `.agents/memory/daily/` files for project context.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead. Do not duplicate content from `.agents/memory/` — reference it by path.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

### 3. Save

Resolve the target directory from `forge.yaml` `paths.handoffsDir` (falling back to `docs/handoffs/` if unset). Filename pattern: `handoff-YYYY-MM-DD-session-<brief-description>.md`.

If the operator passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

### 4. Commit

Commit the handoff document so it survives stash operations and is available to the next session. Delegate the commit mechanics to `fo-step-commit` (it resolves the project's commit command and staging rules); where the project has no such skill, use its declared ecosystem commit command.

### 5. Report

Tell the operator the absolute path of the handoff document and suggest opening a fresh session that references it. Report in `aiLanguage`.

## Constraints

- **Save to `docs/handoffs/`** (or the directory resolved from `forge.yaml` `paths.handoffsDir`). Never save to `/tmp/` or other temporary directories.
- **Commit the handoff document** after saving (via `fo-step-commit` or the project's ecosystem commit command).
- **Do not duplicate existing artifacts.** Reference them by path or URL.
- **Redact sensitive information.** API keys, passwords, PII.
- **Stage only the handoff file.** See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
