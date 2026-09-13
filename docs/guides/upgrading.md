# Upgrading Forge

When a new version of `@warpgogol/forge` is published, upgrade additively:

```sh
# 1. Update Forge to the latest version
pnpm update @warpgogol/forge

# 2. Sync skills and binding defaults from the installed version
pnpm exec forge upgrade

# 3. Check project health
pnpm exec forge doctor
```

## What `forge upgrade` does

- Syncs skill definitions from the installed Forge version to `.agents/skills/`
- Updates binding defaults in `forge.yaml` (without overwriting operator-set values)
- Updates `forge.syncedVersion` to track the last synced version
- Is idempotent — running it twice produces the same result
- Never deletes files or overwrites custom configuration

## Preview changes

```sh
pnpm exec forge upgrade --dry-run
```

## What upgrade does NOT do

- Does not overwrite operator-set bindings
- Does not delete files
- Does not modify RFCs, ADRs, or source code
- Does not run tests or builds
