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
forge rfc.verification.emit --id <rfc-id>
forge rfc.implement.stamp --id <rfc-id> --implementation-commit <sha>
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
```

## Naming

```sh
forge naming.convention.lint
```

## Workflow

```sh
forge workflow.lint
forge workflow.list
forge workflow.amend.list
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
forge forge.autonomy.validate
```
