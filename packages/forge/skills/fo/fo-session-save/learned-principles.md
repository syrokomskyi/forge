# Learned Principles

Principles learned across sessions by the `fo-session-save` skill. These are accumulated observations about session transcript quality, metadata extraction accuracy, and annotation patterns.

## Format

Each principle: a concise statement, optionally with a rationale.

---

1. **Always verify RFC-id exists before listing as related.** The `session.save` command extracts RFC-ids via regex (`RFC-\d{4}`), which can match references in comments, URLs, or quoted text. Before confirming a `relatedRfcs` entry, check that the RFC file exists in `docs/rfcs/`.

2. **Commit hash regex matches version numbers — filter by context.** The regex `\b[0-9a-f]{7,40}\b` can match version strings like `1.0.0`. The `session.save` handler filters pure numeric strings ≤ 8 chars, but the skill should also verify that extracted hashes correspond to actual git commits in the session's work.

3. **Session types are not mutually exclusive.** A single session can involve grilling followed by implementation. The `types` array should reflect all major activities, not just the dominant one.

4. **The `## Transcript` section is deterministic output.** Never modify it. Only add `## Session notes` and update frontmatter.

5. **Redact sensitive information before saving.** API keys, passwords, PII must be removed from the transcript. Same redaction pattern as `fo-handoff`.
