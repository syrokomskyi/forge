# @warpgogol/forge

[Українська](README.uk.md) | English

Portable governance engine for AI-assisted project development. Provides skills, RFC/ADR workflows, naming conventions, spec vendoring, and a CLI — all framework-agnostic and dependency-free (only `yaml` + `zod`).

## What you can build with Forge

Forge supports three kinds of projects. You pick one when you start — everything else is automatic.

| Project type | What it is | Example ideas |
| --- | --- | --- |
| **Browser game** | An interactive game that runs in a web browser — 2D, arcade, puzzle, adventure | Catch falling stars, tile-matching puzzle, platformer |
| **Governance / library** | A code library or governance-only project — no website, no game, no video, just structure and documentation | npm package, internal toolkit, documentation hub |
| **Godot game** | A desktop or mobile game built with Godot 4.x and C# — 2D, 3D, platformer, RPG | Top-down adventure, 3D platformer, puzzle game |

Each project type gets its own scaffold: the right folder structure, the right dependencies, the right tools. You don't need to know what any of those are — Forge sets them up for you.

---

## Forge and the Werkstatt engine

Forge is the **governance layer** — skills, RFC/ADR workflows, naming conventions, spec vendoring, and the CLI. It is framework-agnostic and has zero runtime dependencies (only `yaml` + `zod`).

For full project lifecycle management — missions, releases, deployment, certification, quality checks, content codegen — Forge connects to the **Werkstatt engine** and **stack-specific plugins**. These are separate npm packages installed alongside Forge when you need runtime capabilities beyond governance.

| Package | Purpose | Required for |
| --- | --- | --- |
| `@warpgogol/werkstatt` | Runtime engine — missions, releases, Leitstand deployment, certification, Bordbuch, artifact store | All project types with lifecycle management |
| `@warpgogol/werkstatt-shared` | Shared infrastructure — checks, integration, ontology, passport | Installed automatically with the engine |
| `@warpgogol/werkstatt-game` | Phaser game plugin — game validators, Vite build, deploy adapters | Browser game projects (`phaser-turborepo`) |
| `@warpgogol/werkstatt-godot` | Godot plugin — scene validators, dotnet build, itch.io deploy, Godot skills | Godot game projects (`godot-csharp`) |

### When you need these packages

- **Governance-only projects** (RFCs, ADRs, skills, documentation hubs) — Forge alone is sufficient.
- **Games, Godot projects** — install `@warpgogol/werkstatt` (the engine) plus the matching stack plugin. The `forge-bootstrap` skill configures bindings automatically; the packages themselves must be installed as devDependencies.

### Installing engine packages

```sh
# Browser game project
pnpm add -D @warpgogol/werkstatt @warpgogol/werkstatt-game

# Godot game project
pnpm add -D @warpgogol/werkstatt @warpgogol/werkstatt-godot
```

> **Note for agents:** When scaffolding a new project with `forge create`, always install the engine and matching stack plugin after the scaffold completes. The `forge.yaml` bindings reference commands from these packages (e.g. `pnpm exec werkstatt run rfc.validate`), and they will fail if the packages are not installed.

---

## Complete installation guide (from zero)

If you've never programmed before, this section takes you from a completely empty computer to a working Forge setup. Follow the steps for your operating system.

### What you need

You need two free programs:

- **Node.js** (version 24 or newer) — lets your computer run JavaScript tools.
- **pnpm** — the package manager Forge uses to install dependencies. It's built into Node.js and just needs to be switched on.

Both are free. You install Node.js first, then enable pnpm with a single command.

### Ubuntu

#### Step 1 — Install Node.js

1. Open the **Terminal** app (press `Ctrl + Alt + T`, or search for "Terminal" in your applications).

2. Download and install Node.js 24 (LTS) by pasting this command and pressing Enter:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs
   ```

   You'll be asked for your password — type it (you won't see the characters as you type, that's normal) and press Enter.

3. Verify it worked:

   ```sh
   node --version
   ```

   You should see a version number like `v22.x.x`, not an error message.

#### Step 2 — Enable pnpm

Node.js includes a tool called **Corepack** that manages package managers. Enable pnpm with:

```sh
corepack enable pnpm
```

Verify:

```sh
pnpm --version
```

You should see a version number like `10.x.x`.

#### Step 3 — Install an AI-powered IDE

Forge works through conversation with an AI agent. You need an IDE that supports AI agents. We recommend **Windsurf** (tested with Forge):

1. Go to [windsurf.com](https://windsurf.com) and download the Linux version.
2. Open the downloaded file and follow the installer.
3. Launch Windsurf.

You can also use **Cursor** ([cursor.com](https://cursor.com)) or any IDE that supports AI agent skills.

### Windows

#### Step 1 — Install Node.js

1. Go to [nodejs.org](https://nodejs.org) in your web browser.
2. Download the **LTS version** (it will say "LTS" and "Recommended for Most Users"). It should be version 22.x or newer.
3. Run the downloaded installer (`.msi` file). Accept all default options by clicking **Next** through each screen, then **Install**. If Windows asks for permission, click **Yes**.

4. Verify it worked. Open **PowerShell** (search for "PowerShell" in the Start menu) and type:

   ```sh
   node --version
   ```

   You should see a version number like `v22.x.x`, not an error message.

#### Step 2 — Enable pnpm

Node.js includes a tool called **Corepack** that manages package managers. Enable pnpm with:

```sh
corepack enable pnpm
```

Verify:

```sh
pnpm --version
```

You should see a version number like `10.x.x`.

#### Step 3 — Install an AI-powered IDE

Forge works through conversation with an AI agent. You need an IDE that supports AI agents. We recommend **Windsurf** (tested with Forge):

1. Go to [windsurf.com](https://windsurf.com) and download the Windows version.
2. Run the downloaded installer and follow the setup wizard.
3. Launch Windsurf.

You can also use **Cursor** ([cursor.com](https://cursor.com)) or any IDE that supports AI agent skills.

### Optional — Install Godot and .NET (only for Godot game projects)

If you're planning to create **Godot game** projects (the `godot-csharp` profile), you need two additional tools:

- **Godot 4.x** (with .NET support) — the game engine. Download it from [godotengine.org/download](https://godotengine.org/download). Make sure to choose the ".NET" version (not the standard version).
- **.NET SDK 8+** — the C# runtime and build tools. Download it from [dotnet.microsoft.com/download](https://dotnet.microsoft.com/download).

Verify both are installed:

```sh
godot --version
dotnet --version
```

### Troubleshooting

- **"command not found" after installing Node.js** — Close and reopen your terminal (Ubuntu) or PowerShell (Windows). The system needs to reload the list of available commands.
- **"corepack: command not found"** — Your Node.js version is too old. Install Node.js 24+ using the steps above.
- **AI agent doesn't know about Forge** — You opened an empty folder, but the AI agent has no Forge context. Run `pnpm dlx @warpgogol/forge create --in-place --profile phaser-turborepo` (or the appropriate profile) in a terminal first, then open the folder in your IDE. The `forge create` command populates the current folder with skills, configuration, and `AGENTS.md` — without it, the AI agent can't discover Forge.

---

## Quick start

### For creative operators — one command, then just talk

You need to run one command in the terminal to create your project. After that, everything works through conversation with an AI agent — no more commands.

#### Start a new project from scratch

1. **Create a project folder and scaffold Forge in-place.** Open a terminal (PowerShell on Windows, Terminal on Ubuntu) and run:

   ```sh
   mkdir my-game
   cd my-game
   pnpm dlx @warpgogol/forge create --in-place --profile phaser-turborepo
   ```

   The project name is derived from the folder name (`my-game` in this example). You can override it with `--name`. This populates the current folder with everything Forge needs — skills, configuration, and project structure. For other project types, use a different `--profile`:

   | What you want to build              | Profile flag                 |
   | ----------------------------------- | ---------------------------- |
   | Browser game (2D, arcade, puzzle)   | `--profile phaser-turborepo` |
   | Godot game (desktop, mobile, 2D/3D) | `--profile godot-csharp`     |
   | Library or governance-only project  | `--profile forge-shell`      |

2. **Open the project folder in your AI IDE.** Open the folder from step 1 in Windsurf or your preferred IDE.

3. **Tell the AI agent what you want to build.** Just type it in the chat, in your own words. For example:

   > I want to build a Godot game where you catch falling stars.

   Or:

   > I want to make a browser game where you catch falling stars.

   Or:

   > I want to create a TypeScript library for calculating astrology charts.

   That's it. The AI agent will do everything else:
   - Set up the project structure based on what you described (game, library, etc.)
   - Configure language preferences and project settings
   - Start a live preview so you can see your work (for games)
   - Tell you the URL to open in your browser

4. **Watch the preview.** For games, the AI agent will give you a localhost link. Click it — your project is already running. As you describe changes, the agent updates the project and the preview refreshes automatically.

   For governance and library projects, there's no visual preview — the agent will set up the project structure and tell you when it's ready.

5. **Create together.** From here on, you just talk. Want a different color? Want to add a scene? Want to add a new function to your library? Just say it. The agent handles all the technical work.

#### Bring an existing project into Forge

If you already have a project somewhere else and want to move it into Forge:

1. **Create a Forge project.** Open a terminal, create a folder, and run:

   ```sh
   mkdir my-project
   cd my-project
   pnpm dlx @warpgogol/forge create --in-place --profile forge-shell
   ```

   Then open the folder in your AI IDE.

2. **Tell the AI agent:**

   > I want to bring my existing project into Forge. It's located at /path/to/my/project.

   The agent will:
   - Detect what kind of project it is (game, library, etc.)
   - Move all your files into the new Forge project — including hidden files like `.env`
   - Optionally bring your git history
   - Verify everything builds correctly
   - Start a live preview (for visual project types)

#### What if something goes wrong?

Just tell the AI agent. It can check the project's health, fix issues, and explain what happened — all in plain language. You never need to open a terminal or run commands yourself.

---

### For developers — CLI commands

#### Create a new project (in-place)

```sh
# Create a project folder, then scaffold Forge in-place
# pnpm dlx downloads Forge temporarily — no global install needed
mkdir my-project
cd my-project
pnpm dlx @warpgogol/forge create --in-place --profile forge-shell

# With a specific stack profile
mkdir my-game && cd my-game
pnpm dlx @warpgogol/forge create --in-place --profile phaser-turborepo

mkdir my-godot-game && cd my-godot-game
pnpm dlx @warpgogol/forge create --in-place --profile godot-csharp

# Override the project name (derived from folder name by default)
pnpm dlx @warpgogol/forge create --in-place --profile forge-shell --name my-custom-name
```

After scaffolding, Forge is installed as a local devDependency. Use `pnpm exec forge` for all subsequent commands within the project:

#### Bring an existing project into Forge

There is no CLI command for transplant — it is an interactive, AI-guided process:

```sh
# 1. Create a new empty Forge project (in-place)
mkdir my-project && cd my-project
pnpm dlx @warpgogol/forge create --in-place --profile forge-shell

# 2. Open the project in Windsurf (tested with forge) or your preferred IDE

# 3. Run the /forge-bootstrap skill and choose "transplant" mode
#    The skill will:
#    - Ask for the path to your existing codebase
#    - Detect the stack automatically (Phaser, Godot, etc.)
#    - Migrate all files (including .env and git-ignored files)
#    - Optionally transfer git history
#    - Verify the build
```

#### Diagnose and validate

```sh
# Check project health
pnpm exec forge doctor

# Validate RFCs
pnpm exec forge rfc.validate

# List available skills
pnpm exec forge skill.list
```

## Stack profiles

A stack profile defines the project scaffold: directory structure, dependencies, CI config, and first workspace. Choose a profile with `--profile` when creating a new project.

| Profile | Project type | Description | First workspace | Use case |
| --- | --- | --- | --- | --- |
| `forge-shell` | Governance / library | Minimal Forge shell (default) | — | Governance-only projects, libraries, non-web projects |
| `phaser-turborepo` | Browser game | Phaser + TypeScript + pnpm + Turborepo | `games/my-game` | Browser games, interactive experiences |
| `godot-csharp` | Godot game | Godot 4.x + C# + pnpm + Turborepo | `games/my-game` | Desktop/mobile games, Godot-based interactive projects |

```sh
# List available profiles (after install)
pnpm exec forge profile.validate
```

When you bring an existing project through the `/forge-bootstrap` transplant mode, Forge detects the matching profile automatically by checking for marker files (`phaser.config.*`, `project.godot`, etc.).

## Upgrade flow

When a new version of `@warpgogol/forge` is published, consumers upgrade additively:

```sh
# 1. Update Forge to the latest version (local devDependency)
pnpm update @warpgogol/forge

# 2. Sync skills and binding defaults from the installed version
pnpm exec forge upgrade

# 3. Check project health
pnpm exec forge doctor
```

`forge upgrade` is additive — it never overwrites operator-set bindings, never deletes files, and is idempotent. It updates `forge.syncedVersion` in `forge.yaml` to track the last synced version. Use `--dry-run` to preview changes.

## What forge gives you

- **44 skills** (fo-pipeline, grilling, preferences, skill authoring) — deployed to `.agents/skills/` by `forge create`
- **RFC workflow** — create, validate, list, graph, archive, acceptance probes, decision logs, DNA trace
- **ADR workflow** — lightweight architectural decision records
- **Spec vendoring** — vendor external spec packages as immutable snapshots with integrity manifests
- **Naming conventions** — kebab-case linting
- **Workflow linting** — validate `.agents/workflows/` frontmatter and references
- **Stack scaffolding** — scaffold a new pnpm + Turborepo monorepo from a profile
- **Bindings contract** — de-hardcode project-specific commands/paths from skills via `forge.yaml`

## Lifecycle

The typical forge project lifecycle:

1. **Create** — `pnpm dlx @warpgogol/forge create --in-place --profile <profile>` scaffolds a new project in the current directory with forge.yaml, skills, and docs directories
2. **IDE** — open the project in Windsurf (tested with forge) or your preferred IDE
3. **Bootstrap** — run `/forge-bootstrap` to configure the project interactively. The skill supports two modes:
   - **Greenfield** — start a new project from scratch: pick a stack, fill in bindings, init git
   - **Transplant** — bring an existing codebase into Forge: detect the stack, migrate code (including git-ignored files like `.env`), optionally transfer git history, verify the build
4. **Upgrade** — when a new `@warpgogol/forge` version is published, run `pnpm exec forge upgrade` to sync skills and binding defaults additively

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
| `os/` | ForgeModule registrations. `compass` and `werkstatt` are fully autonomous (RFC-0556) — all handlers inlined, no `@warpgogol/*` imports. |
| `bin/` | CLI entrypoint (`forge` command). |
| `skills/` | 44 skill definitions (36 fo + 5 shared + 3 meta) with SKILL.md frontmatter. |
| `profiles/` | Stack profiles for `scaffold`. |

## Publishing to npm

This package is published to the npm registry as `@warpgogol/forge`. Publishing is automated via GitHub Actions CI.

### How it works

1. The source lives in the [warpgogol/werkstatt](https://github.com/syrokomskyi/werkstatt) monorepo under `packages/forge/`.
2. [`@warpgogol/repo-extract`](https://github.com/syrokomskyi/repo-extract) extracts the package into the standalone [syrokomskyi/forge](https://github.com/syrokomskyi/forge) repository, flattening it to repo root and stripping workspace dependencies.
3. The generated GitHub Actions CI workflow (`.github/workflows/ci.yml`) runs on every push to `main`: lint → typecheck → build → test → `npm publish --provenance --access public`.
4. The `NPM_TOKEN` secret must be set in the [repository settings](https://github.com/syrokomskyi/forge/settings/secrets/actions).

### Triggering a new release

From the werkstatt monorepo root:

```sh
# 1. Bump the version in packages/forge/package.json
# 2. Run the extraction (extracts + commits + pushes to github.com:syrokomskyi/forge.git)
pnpm exec repo-extract --config packages/forge/extract.config.yaml --verbose

# 3. CI picks up the push and publishes to npm automatically
```

After CI completes, verify the new version on [npmjs.com/package/@warpgogol/forge](https://www.npmjs.com/package/@warpgogol/forge).

## License

Apache-2.0
