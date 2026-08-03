---
name: fo-memory-sync
description: Sync memory and recent sessions from external AI coding tools (Codex CLI, Claude Code) into the current project. Cross-platform, local-only.
invocation: user
category: fo
concerns: content-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
knowledge:
  - qa-log.md
  - fix-patterns.md
  - learned-principles.md
triggers: ["sync memory from codex", "import external agent knowledge", "recall sessions from other tools", "sync memory from claude code"]
---

# fo-memory-sync

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the `my-preferences` skill semantics.

Sync memory and recent sessions from external AI coding tools into the current project so that a fresh agent can pick up knowledge left by other agents who worked on the same project. Runs locally — no network calls, no data exfiltration. Cross-platform: Linux, WSL, Windows.

## Knowledge layers

The skill maintains three knowledge files alongside `SKILL.md`:

- **`fix-patterns.md`** (L1) — baseline patterns for filtering, deduplication, and import decisions. Grown by AI per operator direction.
- **`learned-principles.md`** (L2) — distilled concrete principles extracted from past runs, with `confirmations: N` counter. At N≥3 the skill auto-applies without asking.
- **`qa-log.md`** (L0) — append-only raw Q&A pairs from each run. Used for meta-analysis and prioritizing suggestions.

Read L1 and L2 at the start of each run. Append to L0 during the run. Distill L2 from L0 at the end.

## Source locations

The skill reads from two external tool families. All paths are resolved relative to the home directory.

### Codex CLI

| Platform    | Memory                           | Sessions                         |
| ----------- | -------------------------------- | -------------------------------- |
| Linux / WSL | `~/.codex/memories/`             | `~/.codex/sessions/`             |
| Windows     | `%USERPROFILE%\.codex\memories\` | `%USERPROFILE%\.codex\sessions\` |

Memory files are typically Markdown or plain text. Session files may be JSON, JSONL, or Markdown — read whatever format exists.

### Claude Code

| Platform | Global instructions | Global settings | Project instructions |
| --- | --- | --- | --- |
| Linux / WSL | `~/.claude/CLAUDE.md` | `~/.claude/settings.json` | `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md` |
| Windows | `%USERPROFILE%\.claude\CLAUDE.md` | `%USERPROFILE%\.claude\settings.json` | `<repo>\CLAUDE.md` or `<repo>\.claude\CLAUDE.md` |

Claude Code does not store session history in a standard filesystem location readable by external tools. For Claude Code, the skill reads global and project-level instructions only.

## Process

### 1. Detect platform and resolve paths

Detect the operating system via `process.platform` or equivalent. Resolve the home directory:

- Linux / WSL: `os.homedir()` → typically `/home/<user>`
- Windows: `os.homedir()` → typically `C:\Users\<user>`

Build the full path table for both Codex and Claude Code. Check which paths exist. Skip any source that does not exist — do not error.

### 2. Read knowledge files

Read `fix-patterns.md` and `learned-principles.md` for accumulated filtering and import patterns from previous runs across all projects. Apply only entries with `status: active`; skip entries with `status: stale`, `superseded`, or `archived`.

### 3. Discover external memory and sessions

#### 3a. Codex memories

List all files in `~/.codex/memories/` (or Windows equivalent). Sort by modification time, newest first. Read each file. For each memory file:

1. **Check L2** — is there a learned principle matching this memory's topic + project context? If yes and confirmations ≥3, auto-decide (import or skip) without asking.
2. **Check L1** — is there a baseline pattern matching this memory type? If yes, apply the pattern's filter/import rule.
3. **No match** — ask the operator with 2-3 options. Record the Q&A pair in L0.

#### 3b. Codex sessions

List all files in `~/.codex/sessions/` (or Windows equivalent). Sort by modification time, newest first. Apply the session limit (default: 20, configurable via operator input). For each session file:

1. Read the file. Detect format (JSON, JSONL, Markdown, plain text).
2. Extract: date, session name or ID, first lines of context, project path if present.
3. **Filter by project** — if the session references a project path, check whether it matches the current project root (by path or git remote). If it does not match and the operator did not request all projects, skip it.
4. **Filter by date** — if the operator specified a date range, apply it.
5. **Filter by name** — if the operator specified a session name filter, apply it.

#### 3c. Claude Code instructions

Read `~/.claude/CLAUDE.md` (global instructions) and `<repo>/CLAUDE.md` or `<repo>/.claude/CLAUDE.md` (project instructions). These are instruction files, not session logs — treat them as persistent knowledge that may contain project-relevant conventions.

### 4. Filter and deduplicate

For each discovered item (memory, session, instruction):

1. **Relevance filter** — does the item reference the current project, its file paths, its technologies, or its domain? Score relevance as high / medium / low / irrelevant.
2. **Deduplication** — check whether the knowledge is already present in the project. Search:
   - `AGENTS.md` files at all levels
   - `docs/architecture-dna.md`
   - `docs/rfcs/` and `docs/adrs/`
   - Existing `docs/sessions/` files
   - Memory DB (if accessible)
3. **Staleness check** — is the item older than the last sync? Check L0 for the last sync timestamp for this project.

Items that are irrelevant, duplicated, or stale are listed in the report but not imported.

### 5. Present findings to operator

Present a structured summary in `aiLanguage`. **Translate all labels, headings, and column names to `aiLanguage`** — the template below is structural only.

```
# <fo-memory-sync report in aiLanguage>

## Sources scanned
- Codex memories: N files found (M relevant)
- Codex sessions: N files found (M relevant, K within date range)
- Claude Code instructions: found / not found

## Relevant items
| # | Source | Type | Date | Relevance | Summary | Action |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Codex memory | memory | 2026-07-20 | high | <one-line summary> | import |
| 2 | Codex session | session | 2026-07-22 | medium | <one-line summary> | import |
| 3 | Claude CLAUDE.md | instruction | — | high | <one-line summary> | already present |

## Filtered out
| # | Source | Reason |
| --- | --- | --- |
| 4 | Codex memory | irrelevant — references different project |
| 5 | Codex session | duplicate — knowledge already in AGENTS.md |
```

Ask the operator to confirm which items to import. Use `ask_user_question` with the relevant items as options.

### 6. Import confirmed items

For each confirmed item, route the knowledge to the appropriate destination:

| Knowledge type | Destination | Mechanism |
| --- | --- | --- |
| Project convention or rule | Nearest applicable `AGENTS.md` | Direct edit |
| Architectural decision | `docs/adrs/` | Delegate to `fo-idea-create-adr` |
| Cross-workspace invariant | `ref(forge.yaml bindings.paths.invariantsFile)` | Delegate to `fo-extract-dna` |
| Session context (structured record) | `docs/sessions/` | Create session file |
| Operator preference | `.agents/operator-profile.md` | Direct edit |
| Ephemeral context (import-only) | `.agents/memory/daily/<today>.md` | Append to daily log (RFC-0664) |
| Ephemeral context (mirror) | Memory DB | `create_memory` tool (optional mirror) |

Do not duplicate knowledge already present in the target. Read the target file before editing. Add knowledge in the most concise actionable form.

**Boundary between `docs/sessions/` and `.agents/memory/daily/` (RFC-0664):** `docs/sessions/` holds structured imported session records (from external tools). `.agents/memory/daily/` holds agent-written Context bullets (append-only, git-ignored). Use `docs/sessions/` for imported external sessions; use `.agents/memory/daily/` for ephemeral context bullets that the agent writes during this session.

### 7. Update knowledge files

After the run:

1. Append new Q&A pairs to `qa-log.md` (L0).
2. If new filtering or import patterns emerged, propose them to the operator and append approved patterns to `fix-patterns.md` (L1).
3. If recurring decisions were confirmed, distill principles and append to `learned-principles.md` (L2) with `confirmations: 1`. Increment existing principles if the same decision was made again.
4. Commit knowledge file updates: `git add packages/forge/skills/fo/fo-memory-sync/ && git commit -m "chore: update fo-memory-sync knowledge from run"`.

### 8. Final report

Output a structured summary:

```
# fo-memory-sync summary

## Sync completed
- Project: <project root>
- Date: <YYYY-MM-DD>
- Sources: Codex (memories: N, sessions: M), Claude Code (instructions: found)

## Imported
- AGENTS.md rules: N
- ADRs: N (delegated to fo-idea-create-adr)
- DNA invariants: N (delegated to fo-extract-dna)
- Session files: N
- Memory DB entries: N
- Operator profile entries: N

## Filtered out
- Irrelevant: N
- Duplicate: N
- Stale: N

## Knowledge files updated
- qa-log.md: N new entries
- fix-patterns.md: N new patterns
- learned-principles.md: N new/updated principles

## Next sync
- Suggested: <YYYY-MM-DD> (weekly)
```

## Constraints

- **Local-only.** No network calls, no API requests, no data exfiltration. All reading is from the local filesystem.
- **Read-only on external sources.** Never modify files in `~/.codex/`, `~/.claude/`, or any external tool directory. The skill only reads from those locations.
- **Cross-platform.** Must work on Linux, WSL, and Windows. Use `os.homedir()` and `path.join()` — never hardcode path separators.
- **Operator confirmation mandatory for imports.** Do not import any knowledge without explicit confirmation. Present findings, let the operator choose.
- **No duplication.** Always check whether knowledge is already present in the project before importing. Read target files before editing.
- **Dedup across projects.** Knowledge files (L0/L1/L2) are shared across all projects. Use project path or git remote as the dedup key in `qa-log.md` entries.
- **Commit knowledge files.** After each run, commit updated knowledge files to the forge repo. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session limit.** Default 20 sessions. Prevents reading hundreds of old session files.
- **Sensitive information.** Redact API keys, passwords, and PII from any imported knowledge. Same redaction pattern as `fo-handoff`.
