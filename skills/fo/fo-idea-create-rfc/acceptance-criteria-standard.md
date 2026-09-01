# Acceptance Criteria Authoring Standard (EARS-based)

> Source of truth: RFC-0996. This document is the canonical reference — templates and skills summarize and link to it, never fork the normative wording.

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
