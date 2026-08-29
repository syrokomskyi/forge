# @warpgogol/werkstatt-typescript

Werkstatt plugin for generic TypeScript TurboRepo projects. Implements `werkstatt/plugin@1` with `profileId: "typescript-turborepo"`.

---

## What this package does

This is a **stack plugin** for the [Werkstatt](https://github.com/syrokomskyi/werkstatt) engine. It provides six best-practice validators for TypeScript monorepo projects using Turborepo and pnpm:

- **tsconfig validation** — strict mode, consistent moduleResolution and target across workspace packages
- **Import boundary enforcement** — no packages-to-apps import violations
- **Phantom dependency detection** — all imported packages must be declared in package.json
- **Package exports validation** — package.json exports entries point to existing files
- **Strict mode conventions** — no unescaped `any`, explicit return types on exported functions, no unjustified `@ts-ignore`
- **Barrel export safety** — barrel files do not re-export Node-only modules without subpath exports

You don't use this package on its own — it is loaded by the Werkstatt engine when you create a project with the `typescript-turborepo` profile.

---

## Installation

This package is installed as a devDependency alongside the Werkstatt engine:

```sh
pnpm add -D @warpgogol/werkstatt @warpgogol/werkstatt-typescript
```

> **Note for agents:** When scaffolding a new project with `forge create --profile typescript-turborepo`, always install the engine and this plugin after the scaffold completes. The `forge.yaml` bindings reference commands from these packages, and they will fail if the packages are not installed.

---

## How it fits into the Werkstatt ecosystem

| Package | Role |
| --- | --- |
| `@warpgogol/forge` | Governance layer — skills, RFC/ADR workflows, CLI, project scaffolding |
| `@warpgogol/werkstatt` | Runtime engine — missions, releases, deployment, certification, Bordbuch |
| `@warpgogol/werkstatt-shared` | Shared infrastructure — checks, integration, ontology, passport |
| `@warpgogol/werkstatt-typescript` | **This package** — TypeScript stack plugin with best-practice validators |

**Forge** creates the project and sets up governance. **Werkstatt** manages the lifecycle (missions, releases, deployment). **This plugin** provides TypeScript-specific validators that the engine calls during the check gate.

---

## Validators

The plugin registers 6 kernel commands:

| Command | Invariant | What it checks |
| --- | --- | --- |
| `ts.tsconfig.validate` | TS-001 | tsconfig.base.json exists with `strict: true` and consistent `moduleResolution`/`target` across packages |
| `ts.import.boundaries.validate` | TS-002 | No packages-to-apps import boundary violations |
| `ts.phantom.deps.validate` | TS-003 | No phantom dependencies — all imports declared in package.json |
| `ts.package.exports.validate` | TS-004 | package.json exports entries point to existing files |
| `ts.strict.mode.validate` | TS-005 | Non-test source follows strict-mode conventions (no unescaped `any`, explicit return types, no unjustified `@ts-ignore`) |
| `ts.barrel.validate` | TS-006 | Barrel exports do not re-export Node-only modules without subpath exports |

Validators are standalone kernel commands, not pipeline-integrated. They can be run individually or as part of a check gate.

---

## Stack profile

| Profile | Project type | First workspace | Use case |
| --- | --- | --- | --- |
| `typescript-turborepo` | TypeScript library | — | Generic TypeScript TurboRepo monorepo with best-practice validators |

Create a new TypeScript project:

```sh
mkdir my-ts-project
cd my-ts-project
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript-turborepo
```

---

## Path conventions

| Path | Value |
| --- | --- |
| Content directory | `src` |
| Distribution directory | `dist` |
| Entry points | `src/index.ts` |

---

## Programmatic API

```ts
import { werkstattTypescriptPlugin } from "@warpgogol/werkstatt-typescript";

// Register the plugin with the Werkstatt engine
engine.registerPlugin(werkstattTypescriptPlugin);
```

The plugin exports a single `WerkstattPlugin` object with `profileId: "typescript-turborepo"`. The engine discovers it automatically when the package is installed.

### Subpath exports

| Export | What it provides |
| --- | --- |
| `@warpgogol/werkstatt-typescript` | Plugin entry point (`werkstattTypescriptPlugin`) |
| `@warpgogol/werkstatt-typescript/paths` | TypeScript path conventions |
| `@warpgogol/werkstatt-typescript/invariants` | TS-001..006 invariant declarations |
| `@warpgogol/werkstatt-typescript/checks/module` | Kernel module with validator registrations |

---

## Architecture

```text
src/
  index.ts                          # Plugin entry — werkstattTypescriptPlugin
  paths/
    typescript-paths.ts             # TypeScript path conventions
  invariants/
    typescript-invariants.ts        # TS-001..006 stack invariant declarations
  checks/
    module.ts                       # typescript-checks module registration
    diagnostic-helpers.ts           # Shared diagnostic/summary helpers for validators
    tsconfig-validate.ts            # ts.tsconfig.validate (TS-001)
    import-boundaries-validate.ts   # ts.import.boundaries.validate (TS-002)
    phantom-deps-validate.ts        # ts.phantom.deps.validate (TS-003)
    package-exports-validate.ts     # ts.package.exports.validate (TS-004)
    strict-mode-validate.ts         # ts.strict.mode.validate (TS-005)
    barrel-validate.ts              # ts.barrel.validate (TS-006)
  __tests__/
    plugin-entry.test.ts            # Plugin entry point tests
    validators.test.ts              # Validator unit tests
```

## Architectural constraints

- No imports from `@warpgogol/werkstatt-site` or any other stack plugin.
- No imports from the engine package beyond plugin contract types and kernel types.
- No deploy adapters — deployment is workspace infrastructure.
- No new engine hooks — the hook list is closed at five.
- Use `execFile()` not `exec()` for external binary invocation (DNA-89).
- Validators are standalone kernel commands, not pipeline-integrated.

---

## Publishing to npm

This package is published to the npm registry as `@warpgogol/werkstatt-typescript`. Publishing is automated via GitHub Actions CI.

### How it works

1. The source lives in the [warpgogol/werkstatt](https://github.com/syrokomskyi/werkstatt) monorepo under `packages/werkstatt-typescript/`.
2. [`@warpgogol/repo-extract`](https://github.com/syrokomskyi/repo-extract) extracts the package into the standalone [syrokomskyi/werkstatt-typescript](https://github.com/syrokomskyi/werkstatt-typescript) repository, flattening it to repo root and stripping workspace dependencies.
3. The generated GitHub Actions CI workflow runs on every push to `main`: lint → typecheck → build → test → `npm publish --provenance --access public`.
4. The `NPM_TOKEN` secret must be set in the [repository settings](https://github.com/syrokomskyi/werkstatt-typescript/settings/secrets/actions).

### Triggering a new release

From the werkstatt monorepo root:

```sh
# 1. Bump the version in packages/werkstatt-typescript/package.json
# 2. Run the extraction (extracts + commits + pushes to github.com:syrokomskyi/werkstatt-typescript.git)
pnpm exec repo-extract --config packages/werkstatt-typescript/extract.config.yaml --verbose

# 3. CI picks up the push and publishes to npm automatically
```

After CI completes, verify the new version on [npmjs.com/package/@warpgogol/werkstatt-typescript](https://www.npmjs.com/package/@warpgogol/werkstatt-typescript).

---

## RFC

- **RFC-0889** — Add werkstatt-typescript plugin (TypeScript TurboRepo stack with best-practice validators).

---

## License

Apache-2.0
