---
id: RFC-0000
title: "Short imperative title (e.g. Add structure.validate command)"
status: draft
# kind options: architecture | contract | command | policy | deprecation
kind: architecture
# scope options: app | workspace
scope: workspace
owners:
  - architecture
# Set by the deciding human together with the status change.
# Draft scaffolds must keep this empty; do not prefill a default identity.
# Format: human:<handle>
reviewers: []
createdAt: YYYY-MM-DD
updatedAt: YYYY-MM-DD
implementedAt:
closedAt:
supersedes: []
supersededBy:
amends: []
amendedBy: []
related:
  # Reference DNA invariants, anti-patterns, spec docs, or other RFCs:
  # - DNA-1
  # - AP-3
  # - RFC-0005
# RFC-0331: DNA invariants this RFC implements, protects, or extends.
# Required for architecture/contract RFCs created on or after 2026-07-07.
# Entries must match ^DNA-\d+$ and exist in docs/architecture-dna.md.
satisfies: []
# RFC-0396: Traceability to a vendored spec node: "<spec-id>/<node-id>", e.g. "pbp/RFC-PBP-020".
# Set by spec.materialize; leave commented for non-spec RFCs.
# specRef:
# RFC-0478: Platform versioning enforcement. Declares the SemVer delta this RFC
# produces when implemented. Required for post-cutoff implemented RFCs (V-29).
# Values: minor (Breaks-B, requires migrator), patch (safe), none (prose-only),
# major (architectural, manually reserved). Default: patch.
versionBump: patch
# RFC-0711: Declares that this RFC contributes to a living feature spec
# under docs/specs/live/<domain>.md. When true, domain is auto-derived from
# packagesImpacted[0]. When a string, used as explicit domain override.
# Absent or false means no living spec merge occurs.
# liveSpec: true
commands:
  proposed: []
  added: []
  changed: []
  removed: []
appsImpacted: []
# List only packages actually impacted. Leave empty if unknown.
packagesImpacted: []
successSignals: []
nonGoals: []
# OPTIONAL machine-checkable acceptance probes, executed on-demand
# via `pnpm exec forge rfc.acceptance.run --id <this-rfc-id>` (never
# automatically inside build pipelines).
# acceptance:
#   - probe: run
#     criterion: AC-1
#     command: "pnpm exec forge some.command.validate"
#     expect:
#       exitCode: 0
#   - probe: file-exists
#     criterion: AC-2
#     path: "packages/my-package/src/some-new-module.ts"
#   - probe: command-registered
#     criterion: AC-3
#     name: "some.new.command"
#   - probe: file-contains
#     criterion: AC-4
#     path: "AGENTS.md"
#     pattern: "Some new governance paragraph"
---

# RFC-0000: Short imperative title

## Context

<!-- Why does this RFC exist?
     Describe the observable gap, drift, or risk in the current system.
     Reference Architecture DNA invariants, anti-patterns, or spec documents
     that this RFC is meant to close or protect. -->

## Problem

<!-- What specific invariant is unprotected right now?
     What relies on manual discipline instead of automated or documented enforcement?
     Be concrete: reference file paths, DNA invariant IDs, or known failure modes. -->

## Decision

<!-- State the single decision being made.
     One of:
     - Introduce a new OS command or set of commands
     - Add or change an architectural contract (page, component, semantic, brand, quality)
     - Establish a new governance policy
     - Deprecate or supersede an existing rule or command

     Write it in present tense as if already decided:
     "The kernel gains a `structure.validate` command that checks..."
     not "We should add..." -->

## Architectural fit

<!-- How does this decision relate to existing building blocks?
     Explain alignment with the following — skip any that are not relevant:
     - Architecture DNA (which invariants does this enforce or protect?)
     - Anti-Patterns (which patterns does this prevent?)
     - Page Contracts (which page-level rules are formalized?)
     - Component Contracts (which component-level rules are formalized?)
     - Site OS operator model (command scope, module placement, pipeline integration)
     - Scaling Playbook (does this apply uniformly across growth stages 1–4?) -->

## Design

### CLI surface

<!-- Show the exact command(s) as a user would type them:

```sh
pnpm exec forge domain.command
pnpm exec forge domain.command --json
```

Describe flags, arguments, and scope (app | workspace).
-->

### TypeScript contracts

<!-- Specify the key types and interfaces needed.
     Do not write full implementation — write the minimum contract
     that a developer or agent needs to understand the shape.

```ts
interface ExampleInput {
  // ...
}

interface ExampleResult {
  // ...
}
```
-->

### File system responsibilities

<!-- Which files/directories does this touch or read?
     Which files does this create, validate, or refuse to touch?

| Path | Role |
|---|---|
| `src/**/*.ts` | Scanned for violations |
| `docs/rfcs/index.json` | Updated by rfc.index.generate |
-->

### Output format

<!-- Describe the --json output shape so agents can parse it reliably.

```json
{
  "command": "domain.command",
  "status": "fail",
  "violations": [
    { "file": "src/some-file.ts", "rule": "missing-schema", "message": "..." }
  ]
}
```
-->

### Failure modes

<!-- What does the command do when it finds violations?
     Does it exit non-zero? Does it log warnings only?
     What is the behavior difference between --json and pretty output?
     Are there any rules where the command should warn rather than fail? -->

## Rollout

<!-- Describe the adoption path — not a short-term wave, but a durable rollout strategy:

- Default behavior on first introduction (fail-hard vs. warn vs. opt-in)
- How existing apps adopt without a flag day (e.g., --strict mode, grace period)
- How new apps automatically comply from day one
- Deprecation path if this supersedes an existing command
- How this integrates into the `build.check` or other standard pipelines
-->

## Alternatives considered

<!-- What else was considered and why was it rejected?
     Be brief but honest — this section prevents re-litigating old decisions. -->

## Risks

<!-- Technical, organizational, or agent-facing risks.
     Include: performance impact, false positive rate, maintenance burden,
     risk of agents misinterpreting this RFC. -->

## Acceptance criteria

<!-- Authoring standard: see packages/forge/skills/fo/fo-idea-create-rfc/acceptance-criteria-standard.md (RFC-0996).
     Each criterion is a falsifiable claim about an observable artifact, written in EARS form with a stable AC-N: identifier.
     Required mix: behavior, contract, negative, sync. 3–10 items. One claim = one checking mechanism. -->

- [ ] AC-1: WHEN `<command> --json` is invoked, THE command SHALL return a JSON object matching the documented output schema (evidence: probe:AC-1 or test: <path>)
- [ ] AC-2: THE `<command>` SHALL be registered in the kernel module with the correct name and scope (evidence: file: <module-path>)
- [ ] AC-3: IF `<command>` receives invalid input, THEN THE command SHALL report a blocking error and exit non-zero (evidence: test: <path/to/test>)
- [ ] AC-4: THE relevant `AGENTS.md` SHALL reference this RFC where agent behavior rules changed (evidence: file: <path:line>)

## Implementation notes for agents

<!-- Rules that govern how AI agents interact with this RFC.
     Be explicit. Agents read this section for behavioral policy.

- Agents MAY implement code changes ONLY when this RFC has status: accepted (or implemented).
- Agents MAY transition this RFC from `accepted` to `implemented` per RFC-0224 preconditions; reference this RFC ID in commits.
- For RFCs with acceptance probes: before stamping `implemented`, run
  `pnpm exec forge rfc.verification.emit --id <this-rfc-id>` and commit the evidence file
  in the same commit.
- Agents MUST NOT weaken or remove enforcement rules established by this RFC
  without a new RFC that supersedes it.
- If implementation reveals an invariant conflict, run
  `pnpm exec forge rfc.supersede.propose --id <this-rfc-id> --reason "..." --invariant "DNA-N"`
  instead of working around it.
-->
