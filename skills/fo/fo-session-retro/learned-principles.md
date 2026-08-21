# Learned Principles

Principles learned across sessions by the `fo-session-retro` skill. These are accumulated observations about insight triage quality, categorization accuracy, and routing decisions.

## Format

Each principle: a concise statement, optionally with a rationale.

---

1. **Filter out transient issues.** Pre-existing TypeScript errors, broken builds, or CI failures that are unrelated to the session's work and will be fixed quickly by other agents are NOT useful insights. Do not route them to any destination. Only capture knowledge that remains useful weeks or months later.

2. **Check whether a "rule" is already enforced by a command before routing it to AGENTS.md.** If an automated check already catches the problem (e.g. error code conflicts caught by a validator), the insight is context, not a rule. Rules are for conventions that no command enforces yet.

3. **Filter out one-off completed actions.** Insights that describe a finished migration step, a one-time rename, or any action that won't recur are NOT useful — they describe history, not future-relevant knowledge. Only capture insights that describe patterns, traps, or conventions another agent will encounter again. Test: "Will this situation arise in a future session?" If no, drop.
