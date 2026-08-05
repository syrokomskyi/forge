# @warpgogol/forge

Portable governance engine for AI-assisted project development. Provides skills, RFC/ADR workflows, naming conventions, spec vendoring, and a CLI — all framework-agnostic and dependency-free (only `yaml` + `zod`).

## Install

```sh
npm install @warpgogol/forge
# or
pnpm add @warpgogol/forge
```

## Quick start

### For creative operators — no terminal needed

You don't need to know what a terminal is. You don't need to type a single command. If you have an AI-powered IDE - like Devin (Windsurf), or Cursor, - Forge works entirely through conversation.

#### Start a new project from scratch

1. **Create an empty folder** on your computer — anywhere you like. Name it whatever you want your project to be called (use lowercase letters and hyphens, e.g. `my-brand-video`).

2. **Open that folder in your AI IDE.** The folder is empty — that's exactly what we want.

3. **Tell the AI agent what you want to build.** Just type it in the chat, in your own words. For example:

   > I want to create a brand video for my coffee shop. It should have an animated logo, a short intro, and a product showcase.

   Or:

   > I want to build a website for my photography studio.

   Or:

   > I want to make a browser game where you catch falling stars.

   That's it. The AI agent will do everything else:
   - Install Forge and all necessary tools
   - Set up the project structure based on what you described (video, website, game, etc.)
   - Configure language preferences and project settings
   - Start a live preview so you can see your work
   - Tell you the URL to open in your browser

4. **Watch the preview.** The AI agent will give you a localhost link. Click it — your project is already running. As you describe changes, the agent updates the project and the preview refreshes automatically.

5. **Create together.** From here on, you just talk. Want a different color? Want to add a scene? Want to change the music? Just say it. The agent handles all the technical work.

#### Bring an existing project into Forge

If you already have a project somewhere else and want to move it into Forge:

1. **Create an empty folder** and open it in your AI IDE.

2. **Tell the AI agent:**

   > I want to bring my existing project into Forge. It's located at /path/to/my/project.

   The agent will:
   - Detect what kind of project it is (website, video, game, etc.)
   - Move all your files into the new Forge project — including hidden files like `.env`
   - Optionally bring your git history
   - Verify everything builds correctly
   - Start a live preview

#### What if something goes wrong?

Just tell the AI agent. It can check the project's health, fix issues, and explain what happened — all in plain language. You never need to open a terminal or run commands yourself.

---

### For developers — CLI commands

#### Create a new project

```sh
# Create a new project (scaffold + init + skills + AGENTS.md in one command)
npx forge create my-project

# With a specific stack profile
npx forge create my-site --profile astro-typescript-turborepo
npx forge create my-game --profile phaser-turborepo
npx forge create my-video --profile editframe

# With a non-default package manager
npx forge create my-project --package-manager npm
```

#### Bring an existing project into Forge

There is no CLI command for transplant — it is an interactive, AI-guided process:

```sh
# 1. Create a new empty Forge project
npx forge create my-project

# 2. Open the project in Windsurf (tested with forge) or your preferred IDE

# 3. Run the /forge-bootstrap skill and choose "transplant" mode
#    The skill will:
#    - Ask for the path to your existing codebase
#    - Detect the stack automatically (Astro, Phaser, Editframe, etc.)
#    - Migrate all files (including .env and git-ignored files)
#    - Optionally transfer git history
#    - Verify the build
```

#### Diagnose and validate

```sh
# Check project health
npx forge doctor

# Validate RFCs
npx forge rfc.validate

# List available skills
npx forge skill.list
```

## Stack profiles

A stack profile defines the project scaffold: directory structure, dependencies, CI config, and first workspace. Choose a profile with `--profile` when creating a new project.

| Profile | Description | First workspace | Use case |
| --- | --- | --- | --- |
| `forge-shell` | Minimal Forge shell (default) | — | Governance-only projects, libraries, non-web projects |
| `astro-typescript-turborepo` | Astro + TypeScript + pnpm + Turborepo | `sites/my-site` | Websites, web apps, content-driven sites |
| `phaser-turborepo` | Phaser + TypeScript + pnpm + Turborepo | `games/my-game` | Browser games, interactive experiences |
| `editframe` | Editframe React + Vite + TailwindCSS | `compositions/my-first-video` | Video compositions, brand videos, motion design |

```sh
# List available profiles (after install)
npx forge profile.validate
```

When you bring an existing project through the `/forge-bootstrap` transplant mode, Forge detects the matching profile automatically by checking for marker files (`astro.config.*`, `phaser.config.*`, `editframe.config.*`, etc.).

## Upgrade flow

When a new version of `@warpgogol/forge` is published, consumers upgrade additively:

```sh
# 1. Install the latest version
npm install @warpgogol/forge@latest

# 2. Sync skills and binding defaults from the installed version
npx forge upgrade

# 3. Check project health
npx forge doctor
```

`forge upgrade` is additive — it never overwrites operator-set bindings, never deletes files, and is idempotent. It updates `forge.syncedVersion` in `forge.yaml` to track the last synced version. Use `--dry-run` to preview changes.

## What forge gives you

- **44 skills** (fo-pipeline, grilling, preferences, skill authoring, Editframe video composition) — deployed to `.agents/skills/` by `forge create`
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
3. **Bootstrap** — run `/forge-bootstrap` to configure the project interactively. The skill supports two modes:
   - **Greenfield** — start a new project from scratch: pick a stack, fill in bindings, init git
   - **Transplant** — bring an existing codebase into Forge: detect the stack, migrate code (including git-ignored files like `.env`), optionally transfer git history, verify the build
4. **Upgrade** — when a new `@warpgogol/forge` version is published, run `forge upgrade` to sync skills and binding defaults additively

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
} from "@warpgogol/forge";

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
| `skills/` | 44 skill definitions (36 fo + 5 shared + 3 meta) with SKILL.md frontmatter. |
| `scripts/` | Publication hygiene check (`publish-check.mjs`) run by `prepublishOnly`. |
| `profiles/` | Stack profiles for `forge.scaffold`. |

## Publishing to npm

This package is published to the npm registry as `@warpgogol/forge`. The steps below describe how to publish a new version.

### Prerequisites

- An npm account with publish access to the `@warpgogol` organization.
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

After publishing, verify the new version on [npmjs.com/package/@warpgogol/forge](https://www.npmjs.com/package/@warpgogol/forge).

## License

Apache-2.0
