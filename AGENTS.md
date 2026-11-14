# `@warpgogol/forge` — Agent Guide

Portable governance skills and command modules — the `forge` CLI. Skill lifecycle (`fo-*`), agent-guides generation, RFC/ADR governance, session tooling, and project scaffolding (`forge create`, `forge.init`).

> This repository is the standalone published form of the package. Issues and PRs are welcome here; the upstream source of truth lives in the Warpgogol werkstatt monorepo.

## Architecture

- `src/` — portable, no kernel imports: skill schema, registry, validators, onboarding handlers, config module, canonical types, utilities.
- `os/` — ForgeModule registrations. `os/compass/` and `os/werkstatt/` are fully autonomous (handlers inlined); every `os/*.module.ts` declares a required `runtime` field (`"autonomous"` or `"werkstatt-adapter"`). Only `os/werkstatt/` may import `@warpgogol/werkstatt-engine`; all other `os/` directories are autonomous. Type-only imports (`import type`) are exempt — `forge.autonomy.validate` (FORGE-AUTONOMY-01) enforces this.
- Forge helpers accept `io?: WorkspaceIO` as an OPTIONAL type-only parameter — never import `createDefaultIO` or runtime bindings into `src/`; the ambient path stays the standalone-CLI default and kernel callers pass `context.io` explicitly.
- `bin/` — the `forge` CLI entrypoint for autonomous usage. **New `os/` modules MUST be registered manually in `bin/cli.ts` `buildRegistry()`** — there is no module auto-discovery; a module unregistered there is invisible to `forge <cmd>`.
- `skills/` — the forge-managed skill definitions (`fo-*`). `skills/**` is the canonical source; `.agents/skills/**` in consumer repos is a byte-identical runtime twin written by `forge.init`/`forge.upgrade` — edit the canonical file, never the twin.

## Rules

- Adding or removing a skill under `skills/` changes the `agents.generate` skill table — update affected fixtures/goldens in the same change.
- No `any`, no `@ts-ignore`; helpers stay portable and framework-free in `src/`.
- Use existing dependency versions from `package.json`; do not add deps the task does not need.
- Keep changes small, typed, and tested.

## Commands

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run lint        # eslint src os
pnpm run test        # vitest run --passWithNoTests
pnpm run build       # tsc -p tsconfig.build.json
```

Run typecheck + lint + test before finishing a change; state environment failures explicitly instead of claiming green.
