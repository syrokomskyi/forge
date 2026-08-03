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
triggers: ["session retrospective", "capture insights from this session", "triage session discoveries"]
---

# Session Retro

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Review the current session for discoveries that other agents would benefit from knowing. Categorize each insight and route it to the appropriate durable home. This skill is the **knowledge capture entry point** — it does not duplicate the work of `fo-extract-dna`, `fo-harvest`, or `fo-idea-create-adr`; it triages and delegates.

## When to invoke

- **At session end** — after completing work, before closing the conversation. The operator runs `/fo-session-retro` to check if any insights emerged that deserve to outlive the session.
- **After a debugging session** — when root-cause analysis revealed non-obvious behavior that others would rediscover.
- **After exploring a new area** — when conventions or patterns were learned that are not yet documented.
- **Inline by other skills** — `fo-doc-audit` or session-end workflows may delegate here for the "what did you learn?" step.

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
5. **Do not create `.agents/rules/*.md`** — `.agents/**` is reference/historical only per root AGENTS.md, except `.agents/memory/` (active context store, RFC-0664) and `.agents/skills/` (synced by forge) and `.agents/operator-profile.md` (written by this skill). Rules live in `AGENTS.md` files.

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
- **No `.agents/rules/` files.** Rules live in `AGENTS.md` files, which are loaded into every agent's system prompt. `.agents/**` is reference/historical only per root AGENTS.md, except `.agents/memory/` (active context store, RFC-0664), `.agents/skills/` (synced by forge), and `.agents/operator-profile.md` (written by this skill).
- **Delegation, not duplication.** For ADR, DNA, and pattern insights, delegate to the appropriate skill. Do not create ADRs, RFCs, or forge packages directly.
- **Operator confirmation is mandatory.** Do not route any insight without explicit confirmation of category and destination.
- **Minimal edits.** Add rules in the most concise actionable form. Do not rewrite existing sections.
- **Read before edit.** Always read the target `AGENTS.md` before editing to preserve structure and avoid duplicates.
- **Commit only your own files.** Stage only `AGENTS.md` files this skill edited. Delegated skills commit their own output. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **No pauses for recoverable tool errors.** See `_shared/fo-pipeline-conventions.md` §Recoverable errors.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
