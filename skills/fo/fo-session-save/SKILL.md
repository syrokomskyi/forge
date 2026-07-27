---
name: fo-session-save
description: Enhance saved session transcripts with semantic annotations, summaries, and quality checks. Self-learning via knowledge files.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
knowledge: [qa-log.md, learned-principles.md, fix-patterns.md]
bindings:
  requires: [paths.sessionsDir]
  optional: []
triggers: ["save this session", "enhance session transcript with annotations", "save session with quality checks"]
---

# fo-session-save

Enhance saved session transcripts with semantic annotations, summaries, and quality checks. Self-learning via knowledge files.

## When to use

- At the end of a coding session, after `session.save` has converted raw ATIF files to structured markdown.
- When the operator asks to "save this session" or "annotate the session transcript".
- NOT for session-end insight triage — use `fo-session-retro` for that.

## Process

1. **Read `PREFERENCES.md`** at the repository root. If `saveSessions: false`, exit immediately with "Session saving disabled by operator preference."

2. **Check for raw files** in `docs/sessions/.raw/`. If raw files exist, run `session.save` first to convert them to structured markdown:
   <!-- skill-lint-disable SKILL-11 -->

   ```
   pnpm exec site-kernel run session.save --json
   ```

3. **Read the most recently saved session file** from `docs/sessions/`. If no session files exist, exit with "No session files to annotate."

4. **Read knowledge files** (`qa-log.md`, `learned-principles.md`, `fix-patterns.md`) for accumulated knowledge from previous sessions.

5. **Analyze the transcript semantically:**
   - Generate a 1-3 sentence `summary` of the session's purpose and outcome.
   - Identify key `decisions` made during the session (not just commands mentioned).
   - Identify `relatedArtifacts` — RFCs, ADRs, files, commits that are semantically related.
   - Refine auto-detected `types` — override or extend based on semantic understanding.
   - Verify auto-extracted metadata is accurate; flag and fix false positives.

6. **Update the session file:**
   - Update frontmatter: `summary`, `decisions`, refined `types`, corrected metadata.
   - Append a `## Session notes` section with structured annotations.

7. **Update knowledge files** with any new insights:
   - `qa-log.md`: Log any questions asked and operator answers.
   - `learned-principles.md`: New principles learned across sessions.
   - `fix-patterns.md`: Patterns of errors in auto-extraction and their fixes.

8. **Report** what was annotated/changed.

## Autonomy

- Do NOT ask the operator questions unless you encounter a genuine ambiguity you cannot resolve.
- Read `PREFERENCES.md` at start and no-op if `saveSessions: false`.
- Read knowledge files for accumulated knowledge before processing.
- Write to knowledge files after processing (self-learning).

## Constraints

- **Redact sensitive information**: Remove API keys, passwords, PII from the transcript before saving. Same redaction pattern as `fo-handoff`.
- **Do not modify the `## Transcript` section** — that is the deterministic output of `session.save`. Only add/modify `## Session notes` and frontmatter.
- **Do not delete session files** — archiving is handled by `session.archive`.
- **Verify RFC-ids exist** before listing them in `relatedRfcs` (learned-principles: "always verify RFC-id exists before listing as related").
