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

### K-0005: Combine compaction-chain sessions into one record

```knowledge-entry
id: K-0005
layer: L1
created: 2026-10-18
status: active
```

**Situation:** Two or more session transcripts form a continuation chain (context compaction, resume, same opening prompt with timestamps that abut, or an explicit task handoff where one session spawns another), or a completed session has a still-live continuation.

**Action:** Offer them as one combined `docs/sessions/` record covering the whole arc, naming each session id in `source.sessions`. If the tail session is live, import the completed portion with an explicit "in progress" marker and let the next sync pick up the rest — a later sync that finds new content in an already-imported session **updates that record in place**, it does not create a second file for the same session id (confirmed 2026-10-19: 5e2a513c continuation appended to its existing record; closed out 2026-10-23). Operator chose combined records four times (2026-10-15: 4fb22aac+2c9fbefe; 2026-10-18: 871402ac+e6120a13; 2026-10-18: 5e2a513c+446544ee task-handoff; 2026-10-23: de15db2f+503603ee+8b6dafa1 via `source.sessions` on the parent's self-saved record).

### K-0006: Check for self-saved transcripts before importing

```knowledge-entry
id: K-0006
layer: L1
created: 2026-10-23
status: active
```

**Situation:** A Claude Code session ran the session-end protocol (`saveSessions: true` → `session.save` / `fo-session-retro` step 0) and already wrote its own `docs/sessions/<date>-<hash>.md` record — typically with `summary: ""` and no `source:` block.

**Action:** Do NOT create a second record. Identify the self-saved record by matching its transcript content, commits, or the session's own "транскрипт сохранён: <path>" closing line against `docs/sessions/*.md`. Annotate it in place: add `source: {tool: claude-code, sessions: [<ids>]}` (include spawned children for chains per K-0005), fill `summary`, adjust `types`, and append any transcript tail the self-save missed (e.g. the closing-protocol output itself).

### K-0007: Recover compaction-lost arcs into the self-saved record

```knowledge-entry
id: K-0007
layer: L1
created: 2026-10-27
status: active
```

**Situation:** A self-saved `docs/sessions/` record (K-0006) does not cover the session's whole arc because Claude Code context compactions discarded the earlier portion before `session.save` ran — the record's first transcript entry starts mid-session.

**Action:** Recover the missing arc from the session JSONL itself: each compaction writes a "continued from a previous conversation" summary message listing requests, commits, and files. Insert the recovered portion into the existing record's Transcript before its first entry, prefixed by a `>` blockquote noting it was reconstructed from compaction summaries, update `commits`/`relatedArtifacts`/`decisions`/`date`/`duration` to cover the full arc. Do not create a second record (confirmed 2026-10-27: 19b39511's pre-09:00 arc — expert-audit plans + m000210 fixes + glossary-generator fix — prepended to 0ac736).

### K-0008: Verify claimed state in memory notes before importing

```knowledge-entry
id: K-0008
layer: L1
created: 2026-10-27
status: active
```

**Situation:** A memory note of `type: project` describes work-in-progress state ("drafted, implementation pending") for artifacts that live in the repo (RFCs, plans, missions).

**Action:** Check the repo before proposing import: if the described artifacts already reached their terminal state (RFC `implemented` + archived, plan executed), the note is stale — list in "Filtered out" with reason "stale — <artifacts> already <state>". Do not offer to import stale notes into `.agents/memory/daily/`; operator declined when asked (2026-10-27, formal-invariant-verification-batch vs implemented RFC-1390..1394; re-confirmed 2026-10-30, same note).

### K-0009: Self-save created after the sync record exists

```knowledge-entry
id: K-0009
layer: L1
created: 2026-10-30
status: active
```

**Situation:** The mirror image of K-0006 — a session ran its own `session.save` (creating a raw self-saved `docs/sessions/` record with `summary: ""` and no `source:` block) AFTER a fo-memory-sync run already created the annotated record for the same session id.

**Action:** The sync record stays canonical (it is richer: `source` block, summary, combined chain sessions). Merge any unique content from the self-save into the sync record if the operator asks for tail coverage, then delete the self-save as a duplicate — one record per session id (confirmed 2026-10-30: self-save 2026-10-26-08-00-00-27f385.md deleted, canonical 2026-10-26-11-15-00-a67dda.md kept; operator declined the tail merge. Re-confirmed 2026-10-30: cc3673 merged into canonical 9c753b WITH the tail — merge is wanted when the tail carries real new content like fixes and new RFC drafts; also delete the self-save's `.metrics.yaml` sibling).
