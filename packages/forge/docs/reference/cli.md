# CLI reference

## Core commands

```sh
forge create --in-place --profile <profile> [--name <name>]
forge doctor
forge upgrade [--dry-run]
forge validate
forge dev
forge build
```

## Skills

```sh
forge skill.validate
forge skill.list
forge agents.generate
```

## RFC

```sh
forge rfc.list
forge rfc.validate [--json]
forge rfc.create --title <title> --kind <kind> [--satisfies DNA-N]
forge rfc.acceptance.run --id <rfc-id>
forge rfc.verification.emit --id <rfc-id>
forge rfc.evidence.sync --id <rfc-id>
forge rfc.implement.stamp --id <rfc-id> --implementation-commit <sha>
forge rfc.supersede.propose --id <rfc-id>
forge rfc.decision-log.generate
forge rfc.verify.workspace --id <rfc-id>
```

## ADR

```sh
forge adr.list
forge adr.create
forge adr.validate
forge adr.archive
forge adr.implement.stamp --id <adr-id> --implementation-commit <sha>
```

## Compass

```sh
forge compass.inventory
forge compass.validate
forge compass.summary.trim
forge compass.docs.scaffold [--dry-run]
forge compass.docs.validate
```

The docs-corpus pair manages the six-document Compass semantic layer — `scaffold` materializes/merges it from repository state and writes `bindings.paths.compassDocs`; `validate` gates path/id/link resolution plus the `forge/compass-docs@1` schema marker. See [compass-docs.md](compass-docs.md).

Lifecycle opt-in: `forge create`, `forge init`, and `forge upgrade` accept `--compass-docs` to run the scaffold after the primary operation.

## Naming

```sh
forge naming.convention.lint
```

## Workflow

```sh
forge workflow.lint
forge workflow.list
```

## Spec vendoring

```sh
forge spec.validate
forge spec.status
forge spec.materialize
forge spec.live.merge
forge spec.live.list
forge spec.live.show
forge spec.live.validate
```

## Profiles

```sh
forge profile.validate
forge scaffold
forge port.scaffold
forge port.validate
```

## Plugins

```sh
forge plugin.validate
forge plugin.discover
```

## Program packets

```sh
forge program.packet.validate --id <packet-id>
forge program.packet.seal --id <packet-id>
forge program.packet.lease --id <packet-id>
forge program.packet.complete --id <packet-id>
```

## Session

```sh
forge session.save
forge session.archive
forge session.validate
forge session.list
forge session.audit
forge session.audit.report
forge metrics.aggregate
```

## Docs

```sh
forge docs.archive [--dry-run] [--status <status>]
```

## Public surface

```sh
forge public-surface.validate [--json]
```

## Pinned

```sh
forge pinned.validate
forge pinned.init
```

## Package health

```sh
forge package.health
```

## Autonomy

```sh
forge autonomy.validate
```

## Authority delegations (RFC-1336)

```sh
forge authority.delegate
forge authority.delegate.revoke
forge authority.delegation.list
forge authority.delegation.validate
```

## Agent delegation tiers (RFC-1464)

```sh
forge agent.delegate
forge agent.delegate.tiers.validate
```

## Resolution doors (RFC-1465)

```sh
forge resolver.doors.audit
```

## Instruction budget (RFC-1466)

```sh
forge instructions.budget.validate
forge scar.migrate
```

## Knowledge

```sh
forge knowledge.rebuild
forge knowledge.authz.probe
forge knowledge.conflicts.resolve
```

## Gate probes (RFC-1469)

```sh
forge gate.probe
forge gate.probe.catalog
```

## Context assembly (RFC-1470)

```sh
forge context.index.build
forge context.assemble
forge context.slate.eval
```

## Trajectory memory (RFC-1472)

```sh
forge trajectory.index
forge trajectory.recall
forge trajectory.outcome.record
```

## Check counters (RFC-1473/1474)

```sh
forge checks.counters.validate
forge checks.counters.export
forge checks.contribution.report
```

## YAML scalars (RFC-1478)

```sh
forge yaml.scalars.validate
```

## Conformance (RFC-1365)

```sh
forge conformance.run
forge conformance.validate
```

## Formal proofs (RFC-1391)

```sh
forge proof.check
```

## Frictions (RFC-1433)

```sh
forge friction.validate
```

## Queue (RFC-1140)

```sh
forge queue.validate
```

## Werkstatt adapter

```sh
forge werkstatt.lock.status
forge werkstatt.lock.recover
forge werkstatt.operation.validate
forge werkstatt.session.open
forge werkstatt.session.close
forge werkstatt.session.status
```

## Explorations & notes

```sh
forge exploration.list
forge exploration.show
forge exploration.archive
forge note.link.validate
forge note.frontmatter.validate
forge note.orphan.detect
```
