# Governance model

Forge governs AI-assisted development across five planes:

## Intent

RFCs (Request for Comments) capture architectural decisions before implementation. Each RFC has a status lifecycle: draft → accepted → implemented → archived. RFCs can reference Architecture DNA invariants and include machine-checkable acceptance probes.

ADRs (Architectural Decision Records) are lightweight decision logs for local technical decisions that don't need a full RFC.

## Decisions

Every RFC and ADR is tracked. Decision logs are generated automatically. `forge rfc.list` and `forge adr.list` show the current state. The decision log is a generated artifact — never edit it manually.

## Agent behavior

Repository-local skills define repeatable workflows. Forge ships 37 skills (29 `fo-` skills + 5 shared + 3 meta). Projects can declare their own skill packs with custom prefixes.

Skills are deployed to `.agents/skills/` by `forge create` and synced by `forge upgrade`. The agent discovers and invokes skills based on their descriptions.

## Verification

- `forge doctor` — checks project health (contract, skills, RFC registry, ADR registry, bindings)
- `forge rfc.validate` — validates all RFCs against the schema and lifecycle rules
- `forge compass.validate` — validates source-file contract blocks (MODULE_CONTRACT, CHANGE_SUMMARY)
- `forge naming.convention.lint` — enforces kebab-case naming
- `forge public-surface.validate` — checks README/package.json consistency

## Evolution

- `forge upgrade` — syncs skills and binding defaults from the installed Forge version. Additive and idempotent.
- `forge profile.validate` — validates stack profiles
- Spec vendoring — vendor external spec packages as immutable snapshots with integrity manifests
