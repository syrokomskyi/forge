---
name: fo-session-retro
description: Session-end insight triage — review what was discovered, categorize each insight, and route it to the right durable home (AGENTS.md rule, ADR, DNA invariant, forge pattern, or memory).
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: [paths.invariantsFile]
triggers: ["session retrospective", "capture insights from this session", "triage session discoveries", "Завершаем сессию", "/session-end"]
---

# Session Retro

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Review the current session for discoveries that other agents would benefit from knowing. Categorize each insight and route it to the appropriate durable home. This skill is the **knowledge capture entry point** — it does not duplicate the work of `fo-extract-dna`, `fo-harvest`, or `fo-idea-create-adr`; it triages and delegates.

## When to invoke

- **At session end** — after completing work, before closing the conversation. The operator runs `/fo-session-retro` to check if any insights emerged that deserve to outlive the session.
- **After a debugging session** — when root-cause analysis revealed non-obvious behavior that others would rediscover.
- **After exploring a new area** — when conventions or patterns were learned that are not yet documented.
- **Inline by other skills** — `fo-doc-audit` or session-end workflows may delegate here for the "what did you learn?" step.

### Session-end trigger phrases (BLOCKED GATE — NON-NEGOTIABLE)

When the operator says any of the following, the agent's response is **BLOCKED** — no closing summary, no ad-hoc "session complete" message, no closing block is permitted until this skill is invoked via the `skill` tool and completes:

- "Завершаем эту сессию"
- "Завершаем сессию"
- "Заканчиваем сессию"
- "Завершить сессию"
- "End session"
- "Wrap up"
- "Session end"
- "/session-end"

**The agent MUST NOT produce any session-end output (summary, closing block, "session complete" message) before this skill is invoked and its report is presented. Producing a closing summary without running this skill is a CONTRACT VIOLATION.**

This skill IS the session-end protocol — it runs transcript save, temp cleanup, docs.archive, clean tree check, RFC verification, insight triage, and produces the closing block. Do not substitute it with a manual summary. The closing block comes from this skill's report, not from the agent directly.

## Step 0: Save session transcript (NON-NEGOTIABLE when saveSessions is true)

This step ensures the session transcript is persisted to `docs/sessions/` before any retro work begins. Without it, the transcript is lost when the conversation closes.

### 0a. Check preference

Read `PREFERENCES.md` at the repository root. If `saveSessions: false`, skip this step entirely and proceed to Step 1.

### 0b. Construct raw ATIF file

The agent reconstructs the current session's conversation from its context window and writes it as a JSON-lines ATIF file to `docs/sessions/.raw/`. Each line is a JSON object with `role`, `timestamp`, and `content` fields.

**Format:**

```
{"role":"user","timestamp":"2026-08-04T12:12:00+02:00","content":"<user message>"}
{"role":"assistant","timestamp":"2026-08-04T12:12:05+02:00","content":"<assistant response>"}
{"role":"user","timestamp":"2026-08-04T12:15:00+02:00","content":"<next user message>"}
...
```

**Instructions:**

1. Create the directory `docs/sessions/.raw/` if it does not exist.
2. Generate a timestamp-based filename: `<YYYY-MM-DD-HH-MM-SS>-session.atif` (use current time in the operator's timezone).
3. Reconstruct the conversation from context — include every user message and assistant response you can recall from the current session, in chronological order. This is a best-effort reconstruction: the agent's context window is the source, not an external export tool.
4. **Redact sensitive information** — remove API keys, passwords, PII, and secret values before writing. Replace with `<redacted>`.
5. **Truncate very long tool outputs** — if a tool call produced thousands of lines of output, summarize it as `<tool output truncated, N lines>` in the content field. Keep the tool call name and key results.
6. Write the file using `write_to_file` to `docs/sessions/.raw/<timestamp>-session.atif`.

### 0c. Run session.save

Convert the raw file to structured markdown:

```
ref(forge.yaml bindings.commands.sessionSave)
```

This produces a file at `docs/sessions/<id>.md` with auto-extracted metadata (RFC-ids, commit hashes, file paths, commands, session types) and a `## Transcript` section.

### 0d. Verify

Check that the output file was created in `docs/sessions/`. If `session.save` reported "No raw files to process", the raw file was not written correctly — retry 0b.

If the save succeeded, proceed to Step 1. The saved session file will be annotated later by `fo-session-save` if the operator requests it.

## Pre-retro steps

Before gathering insights, perform these housekeeping steps:

### Step 1: Clean up test temp directories

Remove leftover `tmp-*` and `tmp/` directories created by unit tests anywhere in the repo:

> Commands below assume RTK is installed. To check, run `rtk --version` (this is the detection command — it is not prefixed with `rtk` because it IS an `rtk` command). If `rtk --version` fails, RTK is not installed — run all commands without the `rtk` prefix.

```bash
rtk find . -type d -name 'tmp-*' -not -path './.git/*' -exec rm -rf {} + 2>/dev/null
rtk find . -type d -name 'tmp' -not -path './.git/*' -not -path './node_modules/*' -exec rm -rf {} + 2>/dev/null
```

This is safe to auto-run.

### Step 2: Archive terminal documents

Run the `docs.archive` umbrella command to move terminal RFCs, ADRs, plans, audits, sessions, and missions into their respective `archive/` subdirectories:

```bash
rtk pnpm exec forge docs.archive
```

The command is idempotent — re-running is safe. If files were moved, commit them in step 3 as part of the clean tree check (they are "our" changes).

### Step 3: Clean tree check (NON-NEGOTIABLE)

Verify that this session has no uncommitted changes left in the working tree. Other agents may be working in parallel, so you MUST distinguish your changes from theirs.

**3a. Collect dirty files from all git repos in the workspace:**

```bash
# Workspace root
rtk git status --porcelain
# All active mission workpieces (glob — safe even if no matches)
for d in missions/*/workpiece; do [ -d "$d/.git" ] && echo "=== $d ===" && rtk git -C "$d" status --porcelain; done
```

**3b. Classify each dirty file as "ours" or "unattributed":**

- A file is "ours" if ANY of:
  - You directly modified it via `edit`, `write_to_file`, `multi_edit`, or `edit_notebook` tools.
  - You indirectly modified it by running a command (`run_command`) that generates or updates it (e.g. codegen pipelines, build commands, etc.).
  - It was produced by a session-end pipeline step in THIS session: session transcripts (`docs/sessions/*.md`), review reports (`docs/reviews/**/*.md`), or `docs.archive` moves.
  - It was created by a skill you invoked in this session (e.g. `fo-review` creating a review report, `fo-doc-audit` editing AGENTS.md, `fo-idea-create-adr` creating an ADR).
- A file is "unattributed" if it appears dirty but you have no record of touching it in this session. Do NOT assume it belongs to a parallel agent — it may be an orphan from a previous session that was not committed. The previous session-end protocol should have caught it, but if it didn't, this session must not propagate the problem further.

**3c. Commit our changes:**

- If there are "our" dirty files in the workspace root: `git add <files>` and `git commit -m "<descriptive message>"`.
- If there are "our" dirty files in a workpiece: `git -C missions/<missionId>/workpiece add <files>` and `git -C missions/<missionId>/workpiece commit -m "<descriptive message>"`.
- Use descriptive commit messages that explain what the changes are, not just "session cleanup".

**3d. Handle unattributed dirty files (NON-NEGOTIABLE):**

- If any unattributed dirty files remain after committing ours, present them to the operator via `ask_user_question` (in `aiLanguage`) and ask whether to commit or leave each one untouched. Do NOT silently proceed — unattributed files are often orphans from previous sessions that must be resolved, not propagated.
- For each unattributed file, the operator can choose:
  - **Commit** — the agent stages and commits the file with a descriptive message.
  - **Leave untouched** — the operator explicitly acknowledges the file should remain dirty (e.g. it belongs to a parallel agent still running).
- If the tree is now clean (or was clean from the start), proceed silently.

### Step 4: RFC implementation verification (NON-NEGOTIABLE)

If any RFC was worked on during this session (implementation, audit, enhance, plan, or fix work), verify that each such RFC is either stamped as `implemented` or has an explicit operator-acknowledged reason for remaining in a non-terminal status. This step prevents sessions from ending with silently unfinished RFCs — the agent must either complete the stamp or obtain explicit operator consent to leave the RFC as-is.

**4a. Identify RFCs touched in this session:**

Scan the session conversation and git log for RFC IDs that were the subject of implementation work:

```bash
# Session commits that reference RFCs (adjust --since to session start)
rtk git log --oneline --since="today 00:00:00" --grep="RFC-" -i
```

Also scan the conversation for any `RFC-XXXX` mentions where the agent performed implementation work (code changes, test creation, validator runs, stamp commands, plan/audit/enhance steps). Exclude RFCs that were only mentioned in passing (e.g. referenced as related context but not worked on).

**4b. Check each RFC's status:**

For each identified RFC, read the frontmatter `status` field from `docs/rfcs/rfc-XXXX-*.md` (or `docs/rfcs/archive/implemented/rfc-XXXX-*.md` if already archived by Step 2).

**4c. Classify and act:**

- **Status `implemented`** — the RFC is complete. No action needed.
- **Status `rejected` or `superseded`** — terminal status, no action needed.
- **Status `accepted` (or any other non-terminal status)** — the RFC was worked on but not stamped as `implemented`. This is the state this step targets. For each such RFC, present the status to the operator and ask via `ask_user_question` (in `aiLanguage`):

  | Option | Description |
  | --- | --- |
  | Complete now | The agent proceeds to finish the remaining `fo-idea-implement` steps (3.6–3.8: check acceptance criteria with evidence, stamp implemented). This may require running validators, fixing errors, and committing the stamp. |
  | Leave as-is | The operator explicitly acknowledges the RFC remains in its current non-terminal status with unchecked acceptance criteria. No further action is taken on the RFC. |

  If the operator chooses "Complete now", execute `fo-idea-implement` steps 3.6–3.8 for that RFC before proceeding. If multiple RFCs are in this state, ask about each one (or present them as a batch with `allowMultiple: true`).

**4d. Report:**

Include the RFC status verification result in the session retro report (Step 7). List:

- RFCs verified as `implemented` (count).
- RFCs left in non-terminal status by explicit operator choice (list with RFC IDs and operator's acknowledgment).

If no RFCs were worked on in this session, skip this step silently.

## What this skill is NOT

- It is not `fo-doc-audit` — that skill checks whether existing docs are in sync with code changes. This skill captures **new knowledge** that does not yet exist in any doc.
- It is not `fo-harvest` — that skill scans for portable code patterns. This skill handles all insight types, including non-code knowledge.
- It is not `fo-extract-dna` — that skill formalizes architectural invariants through RFCs. This skill may **delegate** to it when an insight is DNA-grade.
- It is not a memory dump — memory DB is one of five routing targets, not the default. Most insights belong in version-controlled files, not ephemeral memory.

## Insight categories and routing

Each discovered insight is categorized into exactly one of six types. The category determines where the knowledge lives and how it reaches other agents.

| Category | What it is | Destination | Mechanism |
| --- | --- | --- | --- |
| **Rule** | A convention or behavioral expectation that agents must follow | Nearest applicable `AGENTS.md` | Direct edit by this skill |
| **Decision** | An architectural choice with rationale that should be preserved | `docs/adrs/` | Delegate to `fo-idea-create-adr` |
| **Invariant** | A cross-workspace architectural rule that warrants DNA status | `ref(forge.yaml bindings.paths.invariantsFile)` | Delegate to `fo-extract-dna` |
| **Pattern** | A reusable code pattern or abstraction worth porting to forge | `packages/forge/` | Delegate to `fo-harvest` |
| **Operator** | A preference, communication style, or behavioral insight about the operator | `.agents/operator-profile.md` | Direct edit by this skill |
| **Context** | Session-local knowledge with no durable home | `.agents/memory/daily/<today>.md` (default) or `MEMORY.md` (when durable); Memory DB optional mirror | Direct edit (daily log append) or curated edit (MEMORY.md); Memory DB via `create_memory` tool (optional mirror) |

### Category criteria

**Rule** — the insight is:

- A convention agents should follow (not a one-off observation).
- Actionable: "always do X" or "never do Y", not "we learned that...".
- Not architectural enough for DNA (local to one workspace, or not enforceable by a command).
- Already followed in practice but not written down.

**Decision** — the insight is:

- A choice between alternatives with a clear rationale.
- Architectural in nature (package boundaries, technology selection, pattern adoption).
- Not a cross-workspace invariant — it is a point-in-time decision that future changes may revisit.

**Invariant** — the insight is:

- Cross-workspace (applies to multiple apps/packages, not just one).
- Stable (not temporary or migration-period).
- Enforceable (a command could verify it, or it is documentation-only but permanent).
- Not already recorded in `ref(forge.yaml bindings.paths.invariantsFile)`.

**Pattern** — the insight is:

- A code abstraction, utility, or convention that appears in 2+ places.
- Genuinely portable (not project-specific).
- Worth extracting into `packages/forge/` for reuse across projects.

**Context** — the insight is:

- Session-local: relevant to the current task or current state, not a durable rule.
- Not worth a version-controlled file (too specific, too ephemeral).
- Useful for the next agent picking up this work area.

**Operator** — the insight is:

- About the operator's preferences, communication style, or working rhythm (not about code or architecture).
- Cumulative: builds a profile over time that helps the agent calibrate behavior.
- Not a rule for all agents — it is specific to this operator.
- Examples: "prefers concise responses", "works best in morning sessions", "dislikes long explanations", "responds well to visual summaries".

## Insight filtering guidance

When gathering session insights, not every observation deserves to be saved. Apply this filter before presenting the triage table:

**Save as insight** — the observation is:

- A convention or rule that other agents would benefit from following (Rule).
- An architectural choice with rationale worth preserving (Decision).
- A cross-workspace invariant that could warrant DNA status (Invariant).
- A reusable code pattern worth porting (Pattern).
- A preference or behavioral insight about the operator (Operator).
- Session-local context useful for the next agent picking up this work area (Context).

**Do NOT save** — the observation is:

- A one-off fact with no future impact (e.g. "an RFC was skipped due to a duplicate"). These are historical events, not knowledge. They do not help future agents work better.
- A tool quirk already documented elsewhere (check `AGENTS.md` and existing memories first).
- A transient state that will be irrelevant by the next session (e.g. "file X was dirty at session end").
- A bug that was found and fixed in the same session with no broader lesson.

When in doubt, ask: "Would another agent working in this area make a different decision if they knew this?" If the answer is no, drop it.

## Process

### 1. Read preferences and shared conventions

Read `PREFERENCES.md` at the repository root. Use `aiLanguage` for all communication.

Read `_shared/fo-pipeline-conventions.md` for commit discipline, language policy, and recoverable error handling.

### 2. Gather session insights

Review the current session to identify discoveries. Use in priority order:

1. **Explicit operator input** — if the operator described what they learned, use that.
2. **Session conversation** — scan for debugging discoveries, non-obvious behaviors, convention realizations, and "we always do X" moments.
3. **Git diff** — run `git diff HEAD` and `git log --oneline -10` to see what changed; changes may reveal patterns worth recording.

For each candidate, ask: "Would another agent working in this area benefit from knowing this?" If no, drop it. If yes, proceed to categorization.

**No-insights shortcut:** If zero candidates survive filtering, skip Step 3 (Categorize and present) and Step 4 (Route) entirely. Do NOT ask the operator to confirm the absence of insights — proceed directly to Step 7 (Report) with a report that states "No insights found" in the insights section. This avoids a pointless confirmation round when the session produced no durable knowledge worth capturing.

### 3. Categorize and present

**Language requirement (NON-NEGOTIABLE):** The triage table, the `ask_user_question` confirmation prompt, and all inline commentary MUST be written in `PREFERENCES.md` `aiLanguage`. The English template below is structural only — translate ALL headings, column names, labels, and prose to `aiLanguage` before presenting. Only identifiers (file paths, skill names, RFC/ADR ids) stay untranslated. Example: if `aiLanguage` is `ru`, the heading is «Сортировка инсайтов сессии», column headers are «№ | Инсайт | Категория | Назначение | Действие».

Present each insight with a proposed category and routing:

```
## <Triage heading in aiLanguage>

| # | <Insight> | <Category> | <Destination> | <Action> |
| --- | --- | --- | --- | --- |
| 1 | hydrateFromArtifacts is mandatory when steps write state | Rule | packages/AGENTS.md | Direct edit |
| 2 | Model registry chosen over hardcoded clients | Decision | docs/adrs/ | Delegate to fo-idea-create-adr |
| 3 | Gogol ID must not equal phase ID | Invariant | ref(forge.yaml bindings.paths.invariantsFile) | Delegate to fo-extract-dna |
| 4 | Batch AI calls for large-context models | Pattern | packages/forge/ | Delegate to fo-harvest |
| 5 | Operator prefers concise responses without code blocks | Operator | .agents/operator-profile.md | Direct edit |
| 6 | Current pipeline state for mission X | Context | `.agents/memory/daily/` or `MEMORY.md` | Direct edit |
```

Ask the operator to confirm, adjust categories, or drop items using `ask_user_question` — the question text MUST be in `aiLanguage`. Do not proceed without explicit confirmation.

**Confirmation format (NON-NEGOTIABLE):** Use `allowMultiple: true` and present each insight as a separate option, with the option label matching the insight number from the triage table (e.g. option 1 = "1: <insight summary>"). This ensures the operator's response ("1, 2", "3", etc.) unambiguously refers to insight numbers, not to abstract option ordinals. Never use abstract options like "confirm all", "only rules", "only context" — these create a numbering mismatch between the table and the confirmation prompt.

### 4. Route each confirmed insight

#### 4a. Rule → AGENTS.md

For each rule insight:

1. **Identify the nearest applicable `AGENTS.md`** — root, `packages/AGENTS.md`, `services/AGENTS.md`, `docs/authoring/site-composition.md`, or a workspace-specific `AGENTS.md`. Use the same hierarchy rules as `fo-doc-audit` step 2a.
2. **Read** the target file before editing.
3. **Add the rule** in a minimal, actionable form: "Always implement `hydrateFromArtifacts` when a step writes state fields. The engine skips `validateBeforeStart` and `run()` when artifacts are valid, so downstream steps receive empty state." Include a code reference if applicable.
4. **Do not duplicate** rules already present in the target file. If the rule extends an existing section, append to it.
5. **Do not create `.agents/rules/*.md`** — `.agents/**` is reference/historical only per root AGENTS.md, except `.agents/memory/` (active context store), `.agents/skills/` (synced by forge), and `.agents/operator-profile.md` (written by this skill). Rules live in `AGENTS.md` files.

#### 4b. Decision → ADR

Invoke `fo-idea-create-adr` via the `skill` tool with the decision title and rationale gathered from the session. Let it run fully — it will grill, create the file, and validate.

#### 4c. Invariant → DNA

Invoke `fo-extract-dna` via the `skill` tool in convention description mode. Provide the invariant formulation from the session. Let it run fully — it will grill, create the RFC, and report.

#### 4d. Pattern → forge

Invoke `fo-harvest` via the `skill` tool with the pattern description. Let it run fully — it will grill on portability and port if accepted.

#### 4e. Operator → operator-profile.md

For each operator insight:

1. **Read `.agents/operator-profile.md`** if it exists. If it does not exist, create it from the template below.
2. **Determine the target section** based on the insight type:
   - Communication preferences → `## Communication style`
   - Working rhythm / session patterns → `## Working rhythm`
   - Feedback / corrections → `## Feedback history`
   - Emotional state / mood patterns → `## Emotional rhythm`
   - Aesthetic preferences / creative influences → `## Aesthetic preferences`
   - General preferences → `## Preferences`
3. **Add the entry** in a concise form with a date stamp: `- [YYYY-MM-DD] <insight>`.
4. **Entry expiry:** Entries in `## Emotional rhythm` and `## Feedback history` expire after 90 days unless refreshed. When adding a new entry, check existing entries in these sections:
   - If an entry is older than 90 days and has not been refreshed, mark it as `[expired YYYY-MM-DD]` (where the date is the expiry date, not today).
   - An entry is "refreshed" if the same insight is re-confirmed in a later session (update the date stamp).
   - Do not delete expired entries — they remain as historical context but are marked expired.
5. **Zugangsstufen tagging:** Each section must be tagged with an access level:
   - `[Öffentlich]` — visible to co-creators and in developer handoffs.
   - `[Vertraulich]` — private to the operator and the agent; NOT included in developer handoff summaries.
   - `## Emotional rhythm` and `## Feedback history` are always `[Vertraulich]`.
   - `## Communication style`, `## Working rhythm`, `## Aesthetic preferences`, and `## Preferences` are `[Öffentlich]` by default.
6. **Do not include operator-profile.md contents in developer handoff summaries.** Only technical architecture, decisions, and code structure belong in handoffs.

**operator-profile.md template:**

```markdown
# Operator Profile

Cumulative knowledge about the operator. This file is gitignored by default to protect privacy.

## Communication style [Öffentlich]

- [YYYY-MM-DD] <insight>

## Working rhythm [Öffentlich]

- [YYYY-MM-DD] <insight>

## Preferences [Öffentlich]

- [YYYY-MM-DD] <insight>

## Aesthetic preferences [Öffentlich]

- [YYYY-MM-DD] <insight>

## Feedback history [Vertraulich]

- [YYYY-MM-DD] <insight>

## Emotional rhythm [Vertraulich]

- [YYYY-MM-DD] <insight>
```

#### 4f. Context → memory layer

For each context insight, choose the destination with the operator:

1. **Daily log (default)** — append to `.agents/memory/daily/<today>.md` (create if absent). This is the ephemeral warm store — git-ignored, append-only. Format: `- [HH:MM] <insight>`. Redact API keys, passwords, and PII before appending.
2. **MEMORY.md (when durable)** — if the insight is useful across sessions (not just today), append to `.agents/memory/MEMORY.md` under the most relevant section (`## Current focus`, `## Decisions in flight`, or `## Environment notes`). This is the curated hot store — versioned, so keep it concise.
3. **Memory DB (optional mirror)** — use the `create_memory` tool to save the insight with appropriate tags. This is an optional mirror of the file-based layer, not the primary store.

Both daily-log and MEMORY.md edits require operator confirmation. Files are the source of truth; Memory DB is a mirror.

### 5. Commit

Commit rule edits to `AGENTS.md` files separately from any delegated skill output (ADRs, RFCs, forge ports — those skills commit their own files).

```txt
docs: add <rule description> to <AGENTS.md path>

Session retro: captured <N> rule(s) from session insights.
```

Stage only the `AGENTS.md` files this skill edited. Do not stage unrelated changes. See `_shared/fo-pipeline-conventions.md` §Commit discipline.

If no rule insights were confirmed (all were delegated or context), skip this step — the delegated skills handle their own commits.

### 6. Profile review

If any operator insights were routed to `.agents/operator-profile.md`, offer the operator a profile review:

1. **Show the current profile** (or the relevant sections that changed).
2. **Ask:** "Would you like to review or adjust any of these entries?"
3. **Apply adjustments** if the operator requests changes.
4. **Remind the operator** that they can delete `.agents/operator-profile.md` at any time — it is their personal knowledge file.

### 7. Report

Present a concise summary in `aiLanguage`. **ALL labels, headings, column names, and prose MUST be translated to `aiLanguage`** — the template below is structural only. Only identifiers (file paths, skill names, RFC/ADR ids, commit hashes) stay untranslated. This is non-negotiable: an English summary when `aiLanguage` is `ru` is a violation of this skill's language contract.

```
## <Session Retro Summary in aiLanguage>

### <Insights discovered>: <N>
### <Insights confirmed>: <M>

| # | <Insight> | <Category> | <Routed to> | <Status> |
| --- | --- | --- | --- | --- |
| 1 | ... | Rule | packages/AGENTS.md | committed |
| 2 | ... | Decision | fo-idea-create-adr | ADR-XXXX created |
| 3 | ... | Invariant | fo-extract-dna | RFC-XXXX drafted |
| 4 | ... | Pattern | fo-harvest | ported to forge |
| 5 | ... | Operator | .agents/operator-profile.md | committed |
| 6 | ... | Context | `.agents/memory/` | saved |

### <Delegated skills invoked>: <count>
### <Direct edits>: <count>
### <Commit>: <hash | none — no direct edits>
```

## Relationship to other session-end skills

| Skill | Question | Overlap |
| --- | --- | --- |
| `fo-doc-audit` | "Are existing docs accurate?" | Complementary — checks accuracy of existing docs. `fo-session-retro` captures new knowledge. Run `fo-doc-audit` first, then `fo-session-retro`. |
| `fo-handoff` | "What does the next agent need?" | Complementary — writes a handoff doc for continuity. `fo-session-retro` captures durable knowledge. A handoff doc may reference insights captured by `fo-session-retro`. |

Recommended session-end sequence: `fo-doc-audit` → `fo-session-retro` → `fo-handoff`.

## Constraints

- **Document-only.** This skill must not modify, create, or delete source code files. The only files it may directly edit are `AGENTS.md` files (for rule insights) and `.agents/operator-profile.md` (for operator insights, RFC-XXXX). All other routing is via delegation to skills that own their output.
- **No `.agents/rules/` files.** Rules live in `AGENTS.md` files, which are loaded into every agent's system prompt. `.agents/**` is reference/historical only per root AGENTS.md, except `.agents/memory/` (active context store), `.agents/skills/` (synced by forge), and `.agents/operator-profile.md` (written by this skill).
- **Delegation, not duplication.** For ADR, DNA, and pattern insights, delegate to the appropriate skill. Do not create ADRs, RFCs, or forge packages directly.
- **Operator confirmation is mandatory.** Do not route any insight without explicit confirmation of category and destination.
- **Minimal edits.** Add rules in the most concise actionable form. Do not rewrite existing sections.
- **Read before edit.** Always read the target `AGENTS.md` before editing to preserve structure and avoid duplicates.
- **Commit only your own files.** Stage only `AGENTS.md` files this skill edited. Delegated skills commit their own output. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **No pauses for recoverable tool errors.** See `_shared/fo-pipeline-conventions.md` §Recoverable errors.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
