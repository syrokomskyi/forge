# WP-8 Werkstatt Migration Inventory — iteration 0 (2026-11-25)

Scope per program plan: extract studio-operations into a private project-local plugin; retire `werkstatt-engine`/`werkstatt-shared` runtime roles; dissolve `werkstatt-site` (generic Astro knowledge → forge-astro). Completion: werkstatt runs on npm `@warpgogol/forge` v10, zero runtime-semantics dependency on retired packages.

## Engine subsystem classification (54 dirs in `packages/werkstatt-engine/src/`)

### Class S — studio operations (→ private project-local plugin `werkstatt-studio`)
mission, sternsystem, leitstand, bordbuch, bauakte, fleet, lagebild, nachweis, release, deploy, dns, customdomain, subdomain, network, media, sichtpass, werkstatt, workpiece, notausgang, intake, handoff, remediation, certification, capability-artifacts, evolution, behavior-snapshot, journal, hygiene, artifact-store, signing, evidence, integrity, observability

### Class G — generic platform (kernel-grade; largely transferred to v10 forge os/ already or superseded by contract/evidence graph)
kernel, contract, fingerprint, isolation, scope, runtime, schemas, types, component, component-runtime, plugin, agent, agent-gate, onboarding, migrators, testing, e2e, tests, tests-handoff

### Already represented in v10 forge monorepo `os/` (verification needed — same names, different provenance)
agent, plugin, flow, gate, gate-run, correctness, adversarial, codebase, conformance, system, queue

## Migration phases (executable decomposition)

1. **P0 — inventory validation**: verify per subsystem whether v10 forge covers the semantics (many Class-G subsystems transferred during WP-2 conversion; verify nothing kernel-grade is missing by running werkstatt's critical commands against v10 equivalents).
2. **P1 — studio plugin scaffold**: create `packages/werkstatt-studio` in the werkstatt repo as a project-local v10 plugin (forge.plugin.yaml, SDK-based commands); wire into werkstatt `forge.yaml plugins[]`.
3. **P2 — subsystem migration waves** (smallest-first): move studio command implementations behind plugin commands; each wave is one integrate-cycle in werkstatt governance.
4. **P3 — generic Astro knowledge → forge-astro**: content collections, config validation, site-composition checks.
5. **P4 — retirement**: engine/shared runtime roles retired (packages deleted or archived); werkstatt pins npm `@warpgogol/forge` v10.
6. **P5 — Compass sync + AGENTS.md retirement** per program plan.

## Known risks (from RFC + recon)

- Engine is deeply interconnected — subsystem extraction order must respect the dependency direction; measure before sequencing P2.
- `werkstatt-site` dissolution touches every deployed sternsystem's build pipeline — dark-run needed per system class.
- werkstatt-shared's 752 consuming files (RFC-1648 line 54) — the scopeless-bag unwind is the bulk mechanical work.

## Open questions for iteration 1

- Which engine subsystems does the mission-critical path (mission.open → leitstand.ship) actually touch at runtime? (trace before sequencing)
- Does forge v10 need additional SDK surface (e.g. pipeline steps as plugin contributions) before studio extraction is expressible?
