---
name: fo-handoff
description: Compact the conversation into a handoff document for another agent. Saves to docs/handoffs/ (paths.handoffsDir) and commits via the project's commit command (ecosystem.commit where registered).
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggerPhrases: ["create a handoff document", "compact conversation for next agent", "prepare handoff for another agent"]
---

<!--
<MODULE_CONTRACT>
<purpose>fo-handoff skill — Compact the current conversation into a handoff document for another agent to pick up. Saves to docs/handoffs/ (resolved from forge.yaml paths.handoffsDir) and commits via the project's commit command (ecosystem.commit where registered).</purpose>
<non-goals>
  <item>Do not execute skill logic — this document instructs agents; it is not runnable code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1097: sweep — SKILL.md headers + classification fixes

Sweep batch 1: add Compass v2 headers to 45 SKILL.md files (purpose derived from frontmatter description). Fix non-skill-markdown exclusion to check filename not workspace-relative path (packages/AGENTS.md escaped it). Add .coverage to ignoredDirs.</item>
  <item>RFC-1154: commit references resolve by project type — ecosystem.commit where registered, plain git commit in forge workshops</item>
  <item>RFC-1522: defer mid-session rule-file edits and add handoff state checkpoint

fo-idea-implement + fo-idea-plan: rule-file edits collect during plan steps and apply in one pass before rfc.verification.emit (F-0002 — every save re-arms IDE rules re-resolution). fo-handoff: every handoff carries a compact state: YAML block (goal/constraints/verified/changed/validation/rejected/next); dying sessions write it to .agents/memory/daily/<date>.md.</item>
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

### 2a. Structured state checkpoint

Every handoff carries a compact machine-shaped state block — a resumed session reloads it for a fraction of a transcript tail's cost, and stalls make resumes routine (F-0002). Emit it as a `state:` YAML fence inside the handoff document (single greppable file) or a sidecar `state.yaml` next to it:

```yaml
state:
  goal: <one line>
  constraints: [<hard rules in force>]
  verified: [<facts confirmed by commands/tests>]
  changed: [<files touched>]
  validation: { unit: passed|not_run, e2e: passed|failed|not_run }
  rejected: [<hypotheses tested and dropped — prevents re-trying>]
  next: [<ordered remaining steps>]
```

Properties that matter: `verified` facts are distinct from assumptions (anything not confirmed by a command or test does not belong here); `rejected` hypotheses persist across resumes (agents otherwise re-run dead ends); the block stays small enough to re-inject at session start (tens of lines, not hundreds).

**Dying-session fallback:** an agent that realizes a session is degrading mid-task (repeated silent turn-ends, forced `continue` nudges) writes this same block to `.agents/memory/daily/<date>.md` *before* continuing — the file the ecosystem already maintains — so the state survives even if no full handoff is ever emitted.

Do not duplicate content already captured in other artifacts (specs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead. Do not duplicate content from `.agents/memory/` — reference it by path.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

### 3. Save

Resolve the target directory from `forge.yaml` `paths.handoffsDir` (falling back to `docs/handoffs/` if unset). Filename pattern: `handoff-YYYY-MM-DD-session-<brief-description>.md`.

If the operator passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

### 4. Commit

Commit the handoff document so it survives stash operations and is available to the next session. Delegate the commit mechanics to `fo-step-commit` (it resolves the project's commit command and staging rules); where the project has no such skill, use the commit command the project declares — `ecosystem.commit` where it is registered, plain `git commit` otherwise.

### 5. Report

Tell the operator the absolute path of the handoff document and suggest opening a fresh session that references it. Report in `aiLanguage`.

## Constraints

- **Save to `docs/handoffs/`** (or the directory resolved from `forge.yaml` `paths.handoffsDir`). Never save to `/tmp/` or other temporary directories.
- **Commit the handoff document** after saving (via `fo-step-commit` or the project's commit command — `ecosystem.commit` where registered, `git commit` otherwise).
- **Do not duplicate existing artifacts.** Reference them by path or URL.
- **Redact sensitive information.** API keys, passwords, PII.
- **Stage only the handoff file.** See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
