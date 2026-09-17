# AGENTS.md

## Project

`@warpgogol/werkstatt-typescript` — Werkstatt plugin for generic TypeScript TurboRepo projects. Implements `werkstatt/plugin@1` with `profileId: "typescript-turborepo"`. Provides one kernel module (typescript-checks) with six validators, no deploy adapters, no hooks, and TS-001..006 stack invariants.

Priorities when modifying:

1. Preserve plugin contract compliance (`werkstatt/plugin@1`).
2. Keep validators autonomous — no imports from `@warpgogol/werkstatt-engine` beyond kernel types.
3. Make small, typed, and testable changes.
4. Do not break invariants TS-001..006 or existing commands.

## Stack

- TypeScript (strict)
- Turborepo (workspace orchestration)
- pnpm

Use existing versions from `package.json`. Do not add dependencies if the task can be solved with TypeScript or already-installed packages.

## Commands

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm run test
```

Before finishing a change, always run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test
```

If commands fail due to environment, state this explicitly — do not claim verification passed.

## Structure

```text
src/
  index.ts                          # Plugin entry — werkstattTypescriptPlugin
  paths/
    typescript-paths.ts             # TypeScript path conventions
  invariants/
    typescript-invariants.ts        # TS-001..006 stack invariant declarations
  model/
    workspace-model.ts              # TsWorkspaceModel — single workspace scan + AST facts (RFC-1099)
  checks/
    module.ts                       # typescript-checks module registration
    run-ts-check.ts                 # defineTsCheck harness — model + --globs + envelope (RFC-1099)
    diagnostic-helpers.ts           # Shared diagnostic/summary helpers for validators
    tsconfig-validate.ts            # ts.tsconfig.validate (TS-001) — pure rule
    import-boundaries-validate.ts   # ts.import.boundaries.validate (TS-002) — pure rule
    phantom-deps-validate.ts        # ts.phantom.deps.validate (TS-003) — pure rule
    package-exports-validate.ts     # ts.package.exports.validate (TS-004) — pure rule
    strict-mode-validate.ts         # ts.strict.mode.validate (TS-005) — pure rule
    barrel-validate.ts              # ts.barrel.validate (TS-006) — pure rule
  __tests__/
    plugin-entry.test.ts            # Plugin entry point tests
```

Validators are pure rules: each `src/checks/*-validate.ts` exports `create*Command()` built via `defineTsCheck({ name, contract, rules, reads, check })`. The `check(model)` function consumes `TsWorkspaceModel` facts only — no file I/O inside rules. Tests exercise the public `definition.execute()` seam in adjacent `*.test.ts` files.

## Plugin contract

| Field            | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| `schema`         | `werkstatt/plugin@1`                                               |
| `id`             | `werkstatt-typescript`                                             |
| `profileId`      | `typescript-turborepo`                                             |
| `moduleLoaders`  | `checks`                                                           |
| `deployAdapters` | (none)                                                             |
| `hooks`          | (none — validators are standalone, not pipeline-integrated)        |
| `paths`          | `src` (contentDir), `dist` (distDir), `src/index.ts` (entryPoints) |
| `invariants`     | TS-001..006                                                        |

## Architectural constraints

- Do NOT import from `@warpgogol/werkstatt-site` or any other stack plugin.
- Do NOT import from the engine package beyond plugin contract types and kernel types.
- Do NOT add deploy adapters — deployment is workspace infrastructure.
- Do NOT add new engine hooks — the hook list is closed at five.
- Use `execFile()` not `exec()` for external binary invocation (DNA-89).
- Validators are standalone kernel commands, not pipeline-integrated.
- **`tsconfig.json` is JSONC, not JSON** — parse via the TypeScript API (`ts.parseConfigFileTextToJson` / `ts.readConfigFile`), never `JSON.parse`. Comments and trailing commas are legal in tsconfig files.
- **`package.json` `exports` supports `*` wildcards** — validators must expand wildcard subpaths against existing files (regex/glob match), not treat the pattern as a literal path.
- **`module: "NodeNext"` + `moduleResolution: "NodeNext"` is a coupled pair, not a mismatch** — consistency validators must treat identical module/moduleResolution values (and the NodeNext pair specifically) as consistent.

## Scripts

| Script        | Command                                   |
| ------------- | ----------------------------------------- |
| `lint`        | `pnpm exec eslint "src/**/*.ts"`          |
| `typecheck`   | `pnpm exec tsc -p tsconfig.json --noEmit` |
| `build`       | `pnpm exec tsc -p tsconfig.json --noEmit` |
| `build:check` | `pnpm exec tsc -p tsconfig.json --noEmit` |
| `test`        | `vitest run`                              |
| `test:watch`  | `vitest`                                  |

## Invariants

| ID | Description | Check |
| --- | --- | --- |
| TS-001 | tsconfig.base.json exists and has strict: true with consistent moduleResolution and target | `ts.tsconfig.validate` |
| TS-002 | No packages-to-apps import boundary violations | `ts.import.boundaries.validate` |
| TS-003 | No phantom dependencies (imports not declared in package.json) | `ts.phantom.deps.validate` |
| TS-004 | package.json exports entries point to existing files | `ts.package.exports.validate` |
| TS-005 | Non-test source follows strict-mode conventions | `ts.strict.mode.validate` |
| TS-006 | Barrel exports do not re-export Node-only modules without subpath exports | `ts.barrel.validate` |
