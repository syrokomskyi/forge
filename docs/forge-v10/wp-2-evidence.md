# WP-2 evidence — monorepo conversion and core transfer

Evidence digest for Werkstatt RFC-1649 acceptance criteria. Live document — updated as WP-2 increments land.

## AC-5: pre-conversion archive (complete 2026-11-25)

- Export repo state before conversion: `syrokomskyi/forge` mainline at `1f20316e8f8a2968f76cbe0cfbe9d2bd13e65d23` (tree `3ad42bd89fd5ee0ed498f0371340947aa7c8bcfc`), 1684 commits, tag `v9.7.1`.
- Bundle: `warpgogol/archives/forge-export-pre-v10/forge-export-pre-v10-20261125.bundle` (117403553 bytes, `--all` refs).
- Off-machine copy: `r2:forge-preservation/forge-export-pre-v10/forge-export-pre-v10-20261125.bundle` — byte-size verified identical after upload.
- **Verified restorable**, not just existing: fresh clone from the bundle reproduced identical HEAD `1f20316e8` and tree `3ad42bd89` (1684 commits).

## AC-1: filter-import provenance (complete 2026-11-25)

- Source snapshot: werkstatt monorepo `develop` at `02226c043` (post-integration of the program RFC line).
- Single multi-path filter pass (`git filter-repo`, one invocation): `--path packages/forge/ --path packages/werkstatt-typescript/ --path-rename packages/werkstatt-typescript/:packages/forge-typescript/ --prune-empty auto`. Refs pruned to the develop mainline + `forge@*`/`werkstatt-typescript@*` tags before filtering; no stitched per-path imports.
- Result: 1612 commits, real authored history 2026-07-27 ("Initial commit") → 2026-11-25 (`forge@9.7.1` era), original authorship/dates.
- **Tree digest equality** (filtered vs werkstatt source):
  - `packages/forge` — `b20f5167d5a77743b424433cee6bb3079b94e35a` == `b20f5167d5a77743b424433cee6bb3079b94e35a`
  - `packages/forge-typescript` — `8b80f4e4809db584e352dbcc5f074ea3942b40a0` == werkstatt `packages/werkstatt-typescript` same digest
- LFS scan: zero `git-lfs` pointer blobs across all objects in the filtered set (full `--batch-all-objects` scan).

## Layout and scaffolding (complete 2026-11-25)

Scaffold commit `8856325f` separated from the imported history: pnpm workspace, root `forge.yaml`, five-package layout (`forge`, `forge-typescript`, `forge-astro`, `forge-repo-extract`, `forge-system`), CI + trusted-publishing workflows, clean v10 governance seed (`docs/`). Scaffold packages are honest placeholders at `0.0.0` — implementation lands at program WP-5. Branch model decision: `develop` is the mainline (forge flow convention); the force-push replacing the GitHub mainline is operator-gated and deferred until the tree is green end-to-end.

## Zero-dependency excision (complete 2026-11-25, commit `2fb4a1f4`)

- prod runtime edges were exactly 3 — all eliminated by boundary decision, not absorption: `os/werkstatt` (engine adapter) and `os/mission` (studio-private operations) did not transfer.
- `collectFiles`/`byteHash` were already canonical inside forge (inlined per RFC-0303) — the shared bridge was redundant legacy; handlers rewired to the internal utils.
- Absorbed generic pieces: lockfile hygiene → `src/utils/lockfile.ts`; open-mission scan → `os/flow/open-missions.ts` (transitional host-layout awareness, host-port extraction at WP-4/5/8).
- Removed: `forge.autonomy.validate` command (superseded by the permanent contract test), doctor autonomy-guard diagnostic, dead-module tests.
- `forge-typescript` scaffolded down: v9 plugin implementation remains in provenance; its kernel types are exactly what the RFC-1648 SDK redefines at WP-5.
- Protection migration map seeded at `docs/migration/protection-migration-map.yaml` — 6 entries, zero silent losses.

## AC-2/AC-3: contract nodes green (2026-11-25)

- `packages/forge/test/monorepo-layout.test.ts` — exactly five packages, fixed npm identities, independent versions: **green**.
- `packages/forge/test/no-werkstatt-deps.test.ts` — zero import-syntax edges + zero manifest deps on `werkstatt-engine`/`werkstatt-shared` across all packages: **green**.
- typecheck (`tsc --noEmit`): **0 errors**. build (`tsc -p tsconfig.build.json` emit): **green**.

## Remaining for WP-2 completion

- full vitest suite green (monorepo-bound test triage in progress)
- lint green
- tarball smoke on Node 24 (`test:tarball:node24`)
- kernel runtime transfer assessment (the deep RFC-1646/1647/1648-aligned rewrite — continuous with WP-3/4/5)
- operator gates: force-push mainline replacement, npm trusted-publishing configuration, first `10.0.0` publish
