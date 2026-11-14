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
- Reconciles forge-managed artifacts: synced skill dirs get a `.forge-managed` manifest; a stale dir (one whose skill no longer ships upstream) is pruned **only** when its on-disk contents exactly match the recorded manifest. Consumer-owned dirs are never deleted — dirs without a marker, with a corrupt marker, or containing extra files are kept and reported (RFC-1154)
- Injects a delimited forge-managed block into `.prettierignore` for consumers that use prettier
- Merges, never overwrites, editable generated guides: content below `<!-- forge:custom -->` in `AGENTS.md` is preserved verbatim (RFC-1153)

## Preview changes

```sh
pnpm exec forge upgrade --dry-run
```

`--dry-run` also reports `nestedAgentsPlanned` / `nestedAgentsPreserved` / `nestedAgentsSkipped` for nested `AGENTS.md` guides.

## What upgrade does NOT do

- Does not overwrite operator-set bindings
- Does not delete consumer-owned files — only byte-identical stale forge-managed dirs are pruned (above)
- Does not modify RFCs, ADRs, or source code
- Does not run tests or builds
