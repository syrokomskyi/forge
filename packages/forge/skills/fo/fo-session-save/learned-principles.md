<!-- knowledge-layer: L2 -->

# Learned Principles

Principles learned across sessions by the `fo-session-save` skill. These are accumulated observations about session transcript quality, metadata extraction accuracy, and annotation patterns.

### K-0001: Always verify RFC-id exists before listing as related

```knowledge-entry
id: K-0001
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

The `session.save` command extracts RFC-ids via regex (`RFC-\d{4}`), which can match references in comments, URLs, or quoted text. Before confirming a `relatedRfcs` entry, check that the RFC file exists in `docs/rfcs/`.

### K-0002: Commit hash regex matches version numbers — filter by context

```knowledge-entry
id: K-0002
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

The regex `\b[0-9a-f]{7,40}\b` can match version strings like `1.0.0`. The `session.save` handler filters pure numeric strings ≤ 8 chars, but the skill should also verify that extracted hashes correspond to actual git commits in the session's work.

### K-0003: Session types are not mutually exclusive

```knowledge-entry
id: K-0003
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

A single session can involve grilling followed by implementation. The `types` array should reflect all major activities, not just the dominant one.

### K-0004: The `## Transcript` section is deterministic output

```knowledge-entry
id: K-0004
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

Never modify it. Only add `## Session notes` and update frontmatter.

### K-0005: Redact sensitive information before saving

```knowledge-entry
id: K-0005
layer: L2
created: 2026-08-03
lastConfirmedAt: 2026-08-03
confirmations: 1
status: active
```

API keys, passwords, PII must be removed from the transcript. Same redaction pattern as `fo-handoff`.
