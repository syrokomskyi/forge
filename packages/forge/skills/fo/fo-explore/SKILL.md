---
name: fo-explore
description: Explore an idea in the codebase without creating an RFC or ADR. Produces a markdown exploration note in docs/explorations/. Use when the operator wants to weigh options before committing to a specification.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: [paths.invariantsFile]
  optional: []
triggers: ["explore this idea", "let me think about this", "what are the options for", "what if we"]
---

# Explore an idea before specification

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

> **This is a document-only skill.** It produces exploration notes in `docs/explorations/` — nothing else. It must never modify, create, or delete source code files. It must not run build commands, tests, or validation suites. Exploration notes are not governance documents — they have no status transitions, no validation, and no acceptance step. They are informational artifacts that may precede an RFC or ADR.

## Process

### 1. Read the idea

The operator describes what they want to explore. Identify:

- **What is being explored** — the core question or idea.
- **Why exploration is needed** — is the operator unsure about approach, feasibility, or scope?
- **What constraints are known** — packages, DNA invariants, existing RFCs, timeline.

### 2. Explore the codebase

Search for relevant code, existing patterns, constraints, and dependencies. This is interactive — ask clarifying questions if the idea is vague. Use `code_search`, `grep_search`, and `read_file` to understand the current state of the codebase.

If the codebase is empty or inaccessible, document the constraint and focus on option analysis without codebase findings.

### 3. Weigh options

Present 2–5 options with trade-offs. For each option:

- **Approach** — a brief description of how the idea would be implemented.
- **Trade-offs** — pros and cons.
- **DNA alignment** — which invariants from `ref(forge.yaml bindings.paths.invariantsFile)` are relevant.
- **Blockers** — what needs to be resolved first (missing schema, missing command, conflicting RFC).
- **Estimated effort** — small / medium / large.

### 4. Assess feasibility

For each option, identify:

- **Blockers** — missing infrastructure, conflicting decisions, missing RFCs.
- **Required RFCs** — does this option need a new RFC or ADR before implementation?
- **Estimated effort** — small / medium / large.

### 5. Persist the exploration note

Write `docs/explorations/<slug>.md` using the exploration note format below. The slug must be kebab-case, lowercase, latin-only (matching the project naming convention).

If the file already exists, append a new exploration section with a timestamp header instead of overwriting.

After persisting, transition the note's `status` from `open` to `explored` by editing the frontmatter directly. This skill is `concern: document-only` and may edit `.md` files — no separate command is needed for this transition.

### 6. Suggest next steps

Recommend whether to:

- **Create an RFC** — the exploration identified a cross-workspace change that needs governance.
- **Create an ADR** — the exploration identified a local decision that needs recording.
- **Shelve the idea** — the exploration revealed blockers or insufficient value.
- **Explore further** — the exploration raised more questions than it answered.

## Exploration note format

```markdown
---
id: <slug>
title: "<exploration title>"
createdAt: YYYY-MM-DD
status: open
related: []
---

# Exploration: <title>

## Idea

<operator's description>

## Codebase findings

<what the agent found in the codebase — relevant files, existing patterns, constraints>

## Options

### Option 1: <name>
- **Approach:** <description>
- **Trade-offs:** <pros/cons>
- **DNA alignment:** <which invariants are relevant>
- **Blockers:** <what needs to be resolved first>
- **Estimated effort:** <small/medium/large>

### Option 2: <name>
...

## Recommendation

<agent's recommendation with rationale>

## Open questions

- <unresolved questions for the operator>
```

## Frontmatter fields

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Kebab-case slug, matches filename |
| `title` | string | Human-readable title |
| `createdAt` | date | Creation date |
| `status` | enum | `open` (exploration in progress), `explored` (exploration complete, awaiting decision), `archived` (superseded by RFC or shelved) |
| `related` | string[] | RFC/ADR ids that materialized from this exploration |

## File system responsibilities

| Path | Role |
| --- | --- |
| `docs/explorations/<slug>.md` | Exploration note (created by this skill) |
| `docs/explorations/` | Directory for all exploration notes |

## Failure modes

- **Exploration note already exists:** Append a new exploration section with a timestamp header instead of overwriting.
- **Invalid slug:** Slugs must be kebab-case, lowercase, latin-only. Invalid slugs are rejected by `exploration.archive` — exit code 1.
- **No codebase access:** Document the constraint and focus on option analysis without codebase findings.
- **Slug not found:** `exploration.show` and `exploration.archive` return exit code 1 if the slug does not exist.
- **Already archived:** `exploration.archive` is idempotent — if the note is already `archived`, it returns exit code 0 with `previousStatus: "archived"` (no-op).
- **Empty directory:** `exploration.list` returns `{ explorations: [] }` with exit code 0 when `docs/explorations/` is empty or does not exist.

## Constraints

- **No source code changes.** This skill is `concern: document-only`. It may only create and edit `.md` files in `docs/explorations/`.
- **No governance authority.** Exploration notes are not RFCs or ADRs. They do not define contracts, policies, or decisions. They are informational artifacts.
- **No pipeline integration.** Exploration notes are not part of any build or validation pipeline. They are discoverable via `exploration.list` and by browsing `docs/explorations/`.
- **DNA-54 compliance.** Use `ref(forge.yaml bindings.*)` references for paths and commands — no hardcoded project literals in skill instruction lines.
