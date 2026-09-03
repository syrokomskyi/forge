# Acceptance Criteria Authoring Standard (EARS-based)

> Source of truth: RFC-0996 (EARS form, required mix, evidence discipline) and RFC-1006 (phase separation, reject checklist, criterion versioning). This document is the canonical reference — templates and skills summarize and link to it, never fork the normative wording.

## Agent instruction

A criterion is a _falsifiable claim about an observable artifact_, not a description of work performed. Before writing each criterion, answer: _what command, test, or probe would turn red if this claim were false?_ If you cannot answer, the criterion is not ready — rewrite it or insert `> NEEDS CLARIFICATION`.

**Form.** Each criterion carries a stable identifier `AC-N:` and uses EARS-style phrasing:

- Invariant: `AC-N: THE <artifact> SHALL <observable property>`
- Event-driven: `AC-N: WHEN <trigger>, THE <system> SHALL <response> [within <bound>]`
- Failure-path: `AC-N: IF <violation>, THEN THE <system> SHALL <explicit failure behavior>`

**One criterion = one claim = one checking mechanism.** Never bundle ("types defined AND command registered AND docs updated" is three criteria). Each criterion names its mechanism inline or via a probe.

**Required mix.** A well-formed set (3–10 items) covers:

1. **Behavior** — at least one criterion per user-visible or agent-visible behavior change, backed by a `run`/`test` probe or a named test file.
2. **Contract** — schema/type/output-format claims, backed by `file-contains`, schema validation, or a compile check.
3. **Negative** — at least one criterion asserting what _fails_ (wrong input rejected, gate blocks, error escalates). Specs that only describe the happy path are half-specs.
4. **Sync** — docs/AGENTS.md/DNA updates, backed by `file-contains`.

**Forbidden patterns:**

- Effort claims: "code written", "X implemented", "refactored Y".
- Unfalsifiable adverbs: "works correctly", "handles gracefully", "is robust".
- Tautologies: "`rfc.validate` passes on this file" as the only substantive criterion.
- Mind-reading: criteria whose truth requires asking the implementer.
- Copied template boilerplate left unedited.

**Probes.** Every criterion checkable by an existing probe kind MUST get a probe in `acceptance:` frontmatter. Criteria without a feasible probe must state their manual verification procedure explicitly — "manually verified" without a procedure is not evidence.

**Evidence discipline (at check-off time).** `(evidence: ...)` must point to the _mechanism_, not the _artifact_: prefer `probe:AC-N` or `test: path/to/file.test.ts`, then `file:line`. Never check a box based on intention; run the mechanism first.

**Self-test before submitting:** hand the criteria set to a hostile reviewer who has _only_ the repo and a shell. If they cannot verify every box without talking to you, the spec is prose, not a spec.

## Phase separation (RFC-1006)

RFCs have two phases of criteria:

- **RFC-phase (document readiness)** — criteria that gate whether the document itself is ready for acceptance. These live in `## Document readiness` with `DR-N:` identifiers. They are NOT EARS statements about system behavior. Examples: "every considered alternative has a rejection reason", "the RFC states reversibility". Evidence is typically `file:line` pointing to the RFC itself.
- **ADR-phase (acceptance criteria)** — criteria that verify the decision's implementation in the running system. These live in `## Acceptance criteria` with `AC-N:` identifiers. They ARE EARS statements with verification mapping (probe, test, or file:line).

ADRs have only acceptance criteria (no document-readiness section).

## Reject checklist (RFC-1006)

Before submitting criteria, run this line-level reject check. A criterion that triggers any of these is rejected:

1. **Not atomic** — two independently testable behaviors joined by "and" in a single criterion. Split into separate `AC-N` items. (V-39)
2. **Unbounded quantity** — unitless numeric concepts: "fast", "scalable", "reasonable load", "efficiently", "high performance", "low latency". Replace with a specific number or reference the decision that sets it. (V-40)
3. **Weasel verb** — closed set: "handle gracefully", "behave correctly", "as appropriate", "robust", "user-friendly", "works correctly", "is reliable". Replace with a specific observable behavior. (V-41)
4. **No verification mapping** — a checked criterion without `(evidence: ...)` pointing to a mechanism. Already enforced by V-27 and V-37.

The trigger lists for V-40 and V-41 are configuration constants in `validate-rules.ts` — they can be extended without an RFC.

## Criterion versioning (RFC-1006)

Criteria are append-only. To change an accepted criterion:

1. Add a `> Superseded AC-N (YYYY-MM-DD): <reason>` annotation line above the original criterion.
2. Add the new criterion with a new `AC-N` identifier.
3. Never edit an accepted criterion in place — that erases the trace of what shipped.

Superseded criteria are excluded from the unchecked count (V-26) but preserved in the document. Malformed supersession annotations are rejected by V-42.

Example:

```markdown
> Superseded AC-3 (2026-09-15): original criterion was too broad, split into AC-3a and AC-3b
- [x] AC-3: THE command SHALL return exit code 0 for valid input (evidence: test: test.ts:42)
- [x] AC-3a: THE command SHALL return exit code 0 when input matches the schema (evidence: test: test.ts:42)
- [x] AC-3b: IF input does not match the schema, THEN THE command SHALL return exit code 1 (evidence: test: test.ts:58)
```
