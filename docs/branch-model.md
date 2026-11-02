# The fixed branch model

Forge repositories adopt a fixed branch model: two long-lived branches and
short-lived session branches in sibling worktrees, all driven by `flow.*`
commands. Repositories created with `forge create` are born adopted;
existing repositories adopt when the operator runs `pnpm exec forge
flow.install`.

## Branches

- `develop` — integrated work. Sessions merge here through `flow.integrate`;
  it is never committed to directly.
- `main` — released work. It moves only through release operations
  (`flow.cut`, `flow.fix`, `flow.backmerge`).
- `auto/<kind>-<YYMMDD>-<NN>-<slug>` — session branches, created by
  `flow.open` and registered in `forge/registry.yaml`.

The committed guard (`hooks/flow-guard.sh`, installed by `flow.install`)
refuses commits on `develop` and `main`, so the only way work lands is the
flow commands. Inspect state with `pnpm exec forge flow.check` — help:
`pnpm exec forge flow.check --help`.

## Sessions

Every piece of work — a feature, a fix, an experiment — happens inside a
session worktree, never in the primary checkout:

```sh
pnpm exec forge flow.open --kind session --slug my-feature
```

`flow.open` registers the session, creates the `auto/…` branch, and returns
the worktree path — work and commit only there. `hooks/worktree-setup.sh`
(from your stack profile) runs inside the new worktree, e.g. copying `.env`
files and installing dependencies. Help:
`pnpm exec forge flow.open --help`.

## Integration

When a session is ready, the operator integrates it into `develop`:

```sh
pnpm exec forge flow.integrate --branch auto/session-260101-01-my-feature
```

`flow.integrate` rebases the session onto `develop`, runs the profile's
`hooks/integration-gate.sh` inside the worktree (typecheck, lint, tests — a
non-zero exit refuses), and fast-forwards `develop`. To abandon a session
instead, `pnpm exec forge flow.discard --branch <name>` removes the
worktree and its registry entry. Help: `pnpm exec forge flow.integrate
--help`, `pnpm exec forge flow.discard --help`.

## Releases

Releases are derived from tags, never hand-written:

```sh
pnpm exec forge flow.cut                    # repository line
pnpm exec forge flow.cut --lines forge     # package lines
```

`flow.cut` computes the next version from the last reachable annotated
release tag, bumps version files, commits on `develop`, merges to `main`,
and tags the release. `flow.fix` opens a fix session against `main` for
urgent patches; `flow.backmerge` pulls `main` back into `develop`. Help:
`pnpm exec forge flow.cut --help`, `pnpm exec forge flow.fix --help`,
`pnpm exec forge flow.backmerge --help`.

## Outbound

Nothing leaves the machine except through a reviewed digest:

```sh
pnpm exec forge flow.digest            # inspect what a push would publish
pnpm exec forge flow.push --digest <id> # the only outbound path
```

`flow.digest` assembles a risk digest — branches, tags, secrets scan,
workflow tag triggers — and the operator reads it before pushing.
`flow.push` refuses without a matching digest. `flow.hold` / `flow.unhold`
gate risky items. Help: `pnpm exec forge flow.digest --help`,
`pnpm exec forge flow.push --help`, `pnpm exec forge flow.hold --help`.

## State files

`forge/registry.yaml` (sessions), `forge/journal.jsonl` (operation journal)
and `forge/*.lock` live in the git directory of the primary checkout and are
managed exclusively by flow commands — never edit them by hand.

## Adoption

- `forge create` (RFC-1500) scaffolds, commits, and runs `flow.install`
  automatically; `--no-flow` opts out.
- `pnpm exec forge upgrade` reports `flow.state` (`adopted`, `not-adopted`,
  `exempt`, `guard-drift`) without changing the repository.
- `pnpm exec forge flow.install --dry-run` previews adoption for a
  repository created earlier; `pnpm exec forge flow.install` performs it
  and is safe to re-run (it also repairs guard drift).
