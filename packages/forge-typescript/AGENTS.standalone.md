# `@warpgogol/werkstatt-typescript` — Agent Guide

Werkstatt plugin for generic TypeScript TurboRepo projects. Implements the `werkstatt/plugin@1` contract with `profileId: "typescript"`: one kernel module (typescript-checks) with six validators, no deploy adapters, no hooks, and stack invariants TS-001..006.

> This repository is the standalone published form of the package. Issues and PRs are welcome here; the upstream source of truth lives in the Warpgogol werkstatt monorepo.

## Priorities when modifying

1. Preserve plugin contract compliance (`werkstatt/plugin@1`).
2. Keep validators autonomous — no imports from `@warpgogol/werkstatt-engine` beyond kernel types.
3. Make small, typed, and testable changes.
4. Do not break invariants TS-001..006 or existing commands.

## Structure

```text
src/
  index.ts                       # Plugin entry — werkstattTypescriptPlugin
  invariants/                    # TS-001..006 stack invariant declarations
  model/workspace-model.ts       # TsWorkspaceModel — single workspace scan + AST facts
  checks/*-validate.ts           # Six pure-rule validators (TS-001..006)
  __tests__/
```

Validators are pure rules: each `src/checks/*-validate.ts` exports `create*Command()` built via `defineTsCheck({ name, contract, rules, reads, check })`. `check(model)` consumes `TsWorkspaceModel` facts only — no file I/O inside rules.

## Invariants

| ID | Check | Rule |
| --- | --- | --- |
| TS-001 | `ts.tsconfig.validate` | tsconfig.base.json exists, `strict: true`, consistent moduleResolution/target |
| TS-002 | `ts.import.boundaries.validate` | No packages→apps import boundary violations |
| TS-003 | `ts.phantom.deps.validate` | No imports undeclared in package.json |
| TS-004 | `ts.package.exports.validate` | exports entries point to existing files |
| TS-005 | `ts.strict.mode.validate` | Non-test source follows strict-mode conventions |
| TS-006 | `ts.barrel.validate` | Barrels do not re-export Node-only modules without subpath exports |

## Rules

- Validators are standalone kernel commands — do not add deploy adapters or hooks; the hook list is closed.
- `tsconfig.json` is JSONC — parse via the TypeScript API (`ts.parseConfigFileTextToJson`), never `JSON.parse`.
- `package.json` `exports` supports `*` wildcards — expand patterns against existing files, never treat them as literals.
- `module: "NodeNext"` + `moduleResolution: "NodeNext"` is a coupled pair — consistency checks must treat identical values as consistent.
- Use `execFile()`, not `exec()`, for external binaries.
- No `any`, no `@ts-ignore`; use existing dependency versions — do not add deps the task does not need.

## Commands

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm run lint
pnpm run test        # vitest run
```

Run all three before finishing a change; state environment failures explicitly instead of claiming green.
