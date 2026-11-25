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
- Protection migration map seeded at `docs/migration/protection-migration-map.yaml` — 7 entries, zero silent losses.

## AC-2/AC-3: contract nodes green (2026-11-25)

- `packages/forge/test/monorepo-layout.test.ts` — exactly five packages, fixed npm identities, independent versions: **green**.
- `packages/forge/test/no-werkstatt-deps.test.ts` — zero import-syntax edges + zero manifest deps on `werkstatt-engine`/`werkstatt-shared` across all packages: **green**.
- typecheck (`tsc --noEmit`): **0 errors**. build (`tsc -p tsconfig.build.json` emit): **green**.

## Full verification matrix green (2026-11-25, commit `65159f28`)

- **full vitest suite: 478/478 files, 5282 passed / 1 skipped, exit 0.** Monorepo-bound triage: 6 failures analyzed, 3 fixed forward (measure walk-up resolution — vitest NODE_PATH no longer leaks typescript availability; release-lines asserts the v10 monorepo truth; validate-corpus AC-9 parity on a synthesized diverse-YAML corpus), 3 removed as kernel-coupled (RFC-1391 ac8-ac9 acceptance → PMM-0007). One additional failure in the first run did not reproduce in two subsequent full runs — flake-watch item, no reproducible instance.
- **lint: green. typecheck: 0 errors. build: green.**
- **tarball smoke (`test:tarball:node24`): PASS** — the package builds, packs, installs offline into a clean Node-24 consumer, CLI exercised end-to-end.
- CLI smoke: `forge --help` boots, 167 commands registered.
- release line cut: `@warpgogol/forge` version **10.0.0**, engines **>=24** (FI-3/FI-9), dead exports of excised modules removed, CHANGELOG `[10.0.0]` documents the break.

## Kernel runtime transfer assessment (2026-11-25)

RFC-1649 part 3 / RFC-1645 part 1 obligation: which generic runtime roles must land in core as RFC-1646/1647/1648-aligned redesigns. Findings:

- **Already transferred with the command surface** (v9 had port-shaped them): gate-run orchestration + durable records (`os/gate-run/`), detach mechanics (`os/gate-run/detach.ts`), WorkspaceIO ambient implementation and recording-aware call sites, evidence-git judged channel machinery (`src/utils/verifier-git.ts` + consult locks). These are functional in the standalone CLI today.
- **Not present standalone, by design** — the kernel-grade pieces the CLI never owned: module registry with scoped resolution, populated `invoke` port (cross-command governed invocation), kernel-managed cache, telemetry ports. v9 made these optional ports (`invoke?:`, `io?:`), so standalone operation is honest degradation, not breakage.
- **Redesign targets, continuous with program work packages**: contract/evidence graph + cache (WP-3, RFC-1646) — the cache that makes integrate cheap; transactional queue (WP-4, RFC-1647) — serialization of integration units; kernel-grade module registry + invoke port + plugin host (WP-5, RFC-1648) — the SDK the first-party plugins compile against. None of these are copy-paste transfers; the RFCs define them as redesigns, and no standalone-CLI consumer is blocked on them today.

## Remaining gates (operator-owned)

- force-push mainline replacement of `syrokomskyi/forge` (develop → main; the v9 line remains tagged `v9.7.1` + archived in the bundle)
- npm trusted-publishing (OIDC) configuration for `@warpgogol/forge`
- first `10.0.0` publish, then self-host conversion of the forge repo itself (program WP-6)
- evidence mirroring into werkstatt `docs/forge-v10/` per the program plan
