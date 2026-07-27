# @webgogol/forge

Portable governance engine for AI-assisted project development. Provides skills, RFC/ADR workflows, naming conventions, spec vendoring, and a CLI — all framework-agnostic and dependency-free (only `yaml` + `zod`).

## Install

```sh
npm install @webgogol/forge
# or
pnpm add @webgogol/forge
```

## Quick start

```sh
# Create a new project with forge (scaffold + init in one command)
npx forge create my-project

# Diagnose your setup
npx forge doctor

# Validate RFCs
npx forge rfc.validate

# List available skills
npx forge skill.list
```

## Upgrade flow

When a new version of `@webgogol/forge` is published, consumers upgrade additively:

```sh
# 1. Install the latest version
npm install @webgogol/forge@latest

# 2. Sync skills and binding defaults from the installed version
npx forge upgrade

# 3. Check project health
npx forge doctor
```

`forge upgrade` is additive — it never overwrites operator-set bindings, never deletes files, and is idempotent. It updates `forge.syncedVersion` in `forge.yaml` to track the last synced version. Use `--dry-run` to preview changes.

## What forge gives you

- **27 skills** (fo-pipeline, grilling, preferences, skill authoring) — deployed to `.agents/skills/` by `forge create`
- **RFC workflow** — create, validate, list, graph, archive, acceptance probes, decision logs, DNA trace
- **ADR workflow** — lightweight architectural decision records
- **Spec vendoring** — vendor external spec packages as immutable snapshots with integrity manifests
- **Naming conventions** — kebab-case linting
- **Workflow linting** — validate `.agents/workflows/` frontmatter and references
- **Stack scaffolding** — scaffold a new pnpm + Turborepo monorepo from a profile
- **Bindings contract** — de-hardcode project-specific commands/paths from skills via `forge.yaml`

## Lifecycle

The typical forge project lifecycle:

1. **Create** — `forge create` bootstraps a new project with forge.yaml, skills, and docs directories
2. **IDE** — open the project in Windsurf (tested with forge) or your preferred IDE
3. **Bootstrap** — run `/forge-bootstrap` to configure the project (greenfield interview or transplant from an existing codebase)
4. **Upgrade** — when a new `@webgogol/forge` version is published, run `forge upgrade` to sync skills and binding defaults additively

## forge.yaml

The single source of truth for project configuration. Created by `forge create`:

```yaml
schema: forge/config@1
project:
  name: my-project
  stack: [typescript]
  packageManager: pnpm
paths:
  rfcsDir: docs/rfcs
  adrsDir: docs/adrs
  skillsDir: .agents/skills
bindings:
  schema: forge/bindings@1
  commands:
    validateRfc: "forge rfc.validate {id} --json"
    typecheck: "pnpm run build:check"
    test: "pnpm test"
  paths:
    invariantsFile: docs/architecture-dna.md
  terminology:
    invariants: DNA
```

## Programmatic API

```ts
import {
  forgeCoreModule,
  forgeRfcModule,
  loadForgeConfig,
  resolveBinding,
  FORGE_SKILLS,
} from "@webgogol/forge";

// Load config
const config = loadForgeConfig(process.cwd());

// Resolve a binding
const cmd = resolveBinding(config, "commands.validateRfc", { id: "RFC-0001" });

// Register modules in your own registry
const registry = /* your ForgeModuleRegistry */;
await forgeCoreModule.register(registry);
await forgeRfcModule.register(registry);
```

## Architecture

| Directory | Purpose |
| --- | --- |
| `src/` | Portable core — types, config, skills registry, validators, onboarding. Zero `@warpgogol/*` imports. |
| `os/` | ForgeModule registrations. `compass` and `werkstatt` dynamically import `@warpgogol/site-kernel-*` (graceful degradation in autonomous mode). |
| `bin/` | CLI entrypoint (`forge` command). |
| `skills/` | 27 skill definitions (SKILL.md with frontmatter). |
| `scripts/` | Publication hygiene check (`publish-check.mjs`) run by `prepublishOnly`. |
| `profiles/` | Stack profiles for `forge.scaffold`. |

## Publishing to npm

This package is published to the npm registry as `@webgogol/forge`. The steps below describe how to publish a new version.

### Prerequisites

- An npm account with publish access to the `@webgogol` organization.
- Node.js and npm installed locally.

### Creating an access token

1. Log in to [npmjs.com](https://www.npmjs.com/).
2. Go to **Access Tokens** (avatar → Access Tokens).
3. Click **Generate New Token** → select **Classic Token** → type **Publish**.
4. Copy the generated token — it is shown only once.

### Publishing a new version

Run the following commands from the `packages/forge` directory:

```sh
# 1. Authenticate with npm (interactive — prompts for username, password, OTP)
npm login

# 2. Store the auth token for the registry (use the token from the previous step)
npm config set //registry.npmjs.org/:_authToken=<TOKEN>

# 3. Bump the patch version (updates package.json + creates a git commit + tag)
npm version patch

# 4. Publish the package publicly
npm publish --access public
```

After publishing, verify the new version on [npmjs.com/package/@webgogol/forge](https://www.npmjs.com/package/@webgogol/forge).

## License

MIT
