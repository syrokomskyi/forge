# Governance model

Forge governs AI-assisted development across five planes:

## Intent

RFCs (Request for Comments) capture architectural decisions before implementation. Each RFC has a status lifecycle: draft → accepted → implemented → archived. RFCs can reference Architecture DNA invariants and include machine-checkable acceptance probes.

ADRs (Architectural Decision Records) are lightweight decision logs for local technical decisions that don't need a full RFC.

## Decisions

Every RFC and ADR is tracked. Decision logs are generated automatically. `forge rfc.list` and `forge adr.list` show the current state. The decision log is a generated artifact — never edit it manually.

## Agent behavior

Repository-local skills define repeatable workflows. Forge ships 41 skills (34 `fo-` skills + 4 shared + 3 meta) plus the shared agent operating model — EXPLORE/ROUTINE/GOVERNED work modes with explicit authority boundaries and separated completion vocabulary (IMPLEMENTED / VERIFIED / ACCEPTED / RELEASED). Projects can declare their own skill packs with custom prefixes.

Skills are deployed to `.agents/skills/` by `forge create` and synced by `forge upgrade`. The agent discovers and invokes skills based on their descriptions.

## Verification

- `forge doctor` — checks project health (contract, skills, RFC registry, ADR registry, bindings)
- `forge rfc.validate` — validates all RFCs against the schema and lifecycle rules
- `forge compass.validate` — validates source-file contract blocks (MODULE_CONTRACT, CHANGE_SUMMARY)
- `forge naming.convention.lint` — enforces kebab-case naming
- `forge public-surface.validate` — checks README/package.json consistency
- `forge session.audit` / `forge session.audit.report` — deterministic detectors over saved agent sessions (circumvention, blocker deception, false completion claims) and their frequency read-model
- `forge context.index.build` / `forge context.assemble` / `forge context.slate.eval` — budgeted context slates with a recall@budget quality metric
- `forge trajectory.index` / `forge trajectory.recall` / `forge trajectory.outcome.record` — procedure memory extracted from verified sessions only
- `forge gate.probe` / `forge gate.probe.catalog` — seeded-violation probes proving gates still fire on their real scan paths
- `forge conformance.run` / `forge conformance.validate` — producer→consumer contract conformance
- `forge codebase.measure` — repository-scale line and symbol measurement

Instructions, validation and enforcement are distinct levels — see [the verification model](verification-model.md) for what each level does and does not guarantee.

## Evolution

- `forge upgrade` — syncs skills and binding defaults from the installed Forge version. Additive and idempotent.
- `forge profile.validate` — validates stack profiles
- Spec vendoring — vendor external spec packages as immutable snapshots with integrity manifests
