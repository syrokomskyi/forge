# Verification & evidence — scenario guide

Six Forge mechanisms produce evidence about agent work. Each entry follows the same shape: input → operation → output → the human decision it supports. For the guarantee boundaries behind these, read [The verification model](../concepts/verification-model.md).

## Session audit — did the agent do what it claims?

- **Input:** saved session transcripts under `docs/sessions/*.md` (and `archive/`).
- **Operation:** `forge session.audit [--session <id>] [--check] [--relabel] [--deep] [--window <n>]` runs deterministic Stage-A detectors: AUDIT-10 circumvention, AUDIT-11 blocker deception, AUDIT-12 generated-file edits, AUDIT-13 denied retry, AUDIT-14 false completion claims; AUDIT-01/02 report coverage caveats.
- **Output:** one `docs/sessions/audit/<id>.audit.yaml` sidecar per session; `forge session.audit.report` aggregates per-rule frequency and verdict distribution into `docs/metrics/session-audit.generated.yaml`.
- **Human decision:** an AUDIT-14 finding is a signal to re-review that session's diff — a detector, not a verdict. Expect false positives on unusual-but-legitimate sessions; the point is that "the agent says it's done" stops being the only evidence.

## Trajectory memory — reuse procedures that worked

- **Input:** GREEN-verified sessions only — admission happens at extraction, so non-green sessions produce nothing.
- **Operation:** `forge trajectory.index` extracts procedure units into `docs/.index/trajectory/units.yaml`; `forge trajectory.recall --task "<desc>" [--paths <glob>] [--k <n>]` returns top-k units by situation similarity for a new task.
- **Output:** ranked procedure candidates, journaled to `docs/.index/trajectory/recalls.jsonl`.
- **Human decision:** after applying a recalled procedure, record the outcome — `forge trajectory.outcome.record --recall <id> --helped|--hurt [--note <text>]` — so `utilityScore` re-ranking and `producerTrust` decay stale knowledge instead of trusting it forever.

## Context assembly — a bounded, cited context slate

- **Input:** `docs/.index/context/index.yaml`, rebuilt by `forge context.index.build` — a pure-projection unit catalog (session-block, knowledge-entry, friction, remediation, rfc-header, adr-header, skill-manifest, handoff, decision); dropping the directory and rebuilding is the supported reset.
- **Operation:** `forge context.assemble --task "<desc>" [--budget <tokens>] [--paths <glob>] [--auto-index] [--format markdown]` ranks units by lexical overlap + recency + kind weight + path overlap.
- **Output:** a budgeted slate where every unit cites its source and ranking reasons. `forge context.slate.eval` scores recall@budget against the `docs/context-devset/` task→requiredUnits pairs — the completeness metric and the regression gate for ranker changes.
- **Human decision:** read the slate before delegating; a missing unit means the index lacks that source kind, not that the ranker failed.

## Gate probes — prove the gate still fires

- **Input:** declared probe fixtures bound to a rule or contract; `forge gate.probe.catalog` lists per-contract coverage, unprobed error-severity rules (PROBE-03), and stale fixture bindings (PROBE-05).
- **Operation:** `forge gate.probe --rule <id> | --contract <id> | --all | --list` injects the declared violation at its real workspace path — backup → invoke the check → restore.
- **Output:** pass/fail per probe: the gate fired on its real scan path, or it silently stopped protecting the rule.
- **Human decision:** a failed probe means the gate is dead code — fix the wiring before trusting that check's green.

## Conformance — producer→consumer contracts

- **Input:** a declared contract surface between a producer and a consumer.
- **Operation:** `forge conformance.run` executes the consumer's conformance validator against the producer artifact; `forge conformance.validate` checks the declaration itself.
- **Output:** a conformance report — the contract satisfied, or a named violation.
- **Human decision:** a unit test checks intent inside one codebase; conformance checks the boundary two codebases agreed on. A red report blocks the consumer's release of that surface.

## Agent operating model — the shared behavior contract

- **Input:** `skills/_shared/agent-operating-model.md`, shipped as a shared skill and synced to consumers by `forge upgrade`.
- **Operation:** instructs agents on work modes (EXPLORE / ROUTINE / GOVERNED), authority boundaries (the operator owns intent and significant decisions; the agent owns implementation inside them and escalates rather than guesses at a boundary), a proportionate verification portfolio (rigor scales to risk — tests are one tool, not a mandatory-TDD rule), and separated completion vocabulary.
- **Output:** behavioral **instructions** — the model tells the agent to report IMPLEMENTED / VERIFIED / ACCEPTED / RELEASED separately, so a claim never outruns its evidence.
- **Human decision:** the model governs how the agent reports; whether the report is true is what the validators above exist to check.
