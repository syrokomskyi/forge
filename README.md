# @warpgogol/forge

[Українська](README.uk.md) | English

Portable governance engine for AI-assisted project development. Provides skills, RFC/ADR workflows, naming conventions, spec vendoring, and a CLI — all framework-agnostic and dependency-free (only `yaml` + `zod`).

## What you can build with Forge

Forge supports four kinds of projects. You pick one when you start — everything else is automatic.

| Project type | What it is | Example ideas |
| --- | --- | --- |
| **Website** | A public website or web app — pages, blog, portfolio, landing page, online store | Photography studio site, restaurant website, SaaS landing page |
| **Browser game** | An interactive game that runs in a web browser — 2D, arcade, puzzle, adventure | Catch falling stars, tile-matching puzzle, platformer |
| **Video** | A programmatic video composition — animated logo, intro, product showcase, motion design | Brand intro video, product demo, social media ad clip |
| **Governance / library** | A code library or governance-only project — no website, no game, no video, just structure and documentation | npm package, internal toolkit, documentation hub |

Each project type gets its own scaffold: the right folder structure, the right dependencies, the right tools. You don't need to know what any of those are — Forge sets them up for you.

---

## Complete installation guide (from zero)

If you've never programmed before, this section takes you from a completely empty computer to a working Forge setup. Follow the steps for your operating system.

### What you need

You need two free programs:

- **Node.js** (version 22 or newer) — lets your computer run JavaScript tools.
- **pnpm** — the package manager Forge uses to install dependencies. It's built into Node.js and just needs to be switched on.

Both are free. You install Node.js first, then enable pnpm with a single command.

### Ubuntu

#### Step 1 — Install Node.js

1. Open the **Terminal** app (press `Ctrl + Alt + T`, or search for "Terminal" in your applications).

2. Download and install Node.js 22 (LTS) by pasting this command and pressing Enter:

   ```sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
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

#### Step 3 — Install Forge globally

Installing Forge globally means the `forge` command is available everywhere on your computer, not just inside one project:

```sh
pnpm add -g @warpgogol/forge
```

Verify:

```sh
forge --version
```

You should see a version number. Forge is now installed and ready.

#### Step 4 — Install an AI-powered IDE

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

#### Step 3 — Install Forge globally

Installing Forge globally means the `forge` command is available everywhere on your computer, not just inside one project:

```sh
pnpm add -g @warpgogol/forge
```

Verify:

```sh
forge --version
```

You should see a version number. Forge is now installed and ready.

#### Step 4 — Install an AI-powered IDE

Forge works through conversation with an AI agent. You need an IDE that supports AI agents. We recommend **Windsurf** (tested with Forge):

1. Go to [windsurf.com](https://windsurf.com) and download the Windows version.
2. Run the downloaded installer and follow the setup wizard.
3. Launch Windsurf.

You can also use **Cursor** ([cursor.com](https://cursor.com)) or any IDE that supports AI agent skills.

### Optional — Install FFmpeg (only for video projects)

If you're planning to create **video** projects (the `editframe` profile), you need **FFmpeg** — a free tool for processing video and audio.

**Ubuntu:**

```sh
sudo apt-get install -y ffmpeg
ffmpeg -version
```

**Windows:**

1. Go to [ffmpeg.org/download.html](https://ffmpeg.org/download.html) in your browser.
2. Download a Windows build (look for "Windows builds" — the gyan.dev or BtbN builds are good choices).
3. Extract the downloaded `.zip` file to a folder, e.g. `C:\ffmpeg`.
4. Add FFmpeg to your system PATH:
   - Open the Start menu, search for "Environment Variables", and click "Edit the system environment variables".
   - Click **Environment Variables**.
   - Under "System variables" (or "User variables"), find **Path**, select it, and click **Edit**.
   - Click **New** and type `C:\ffmpeg\bin` (or wherever you extracted FFmpeg, in the `bin` subfolder).
   - Click **OK** on all three windows.
5. Close and reopen PowerShell, then verify:

   ```sh
   ffmpeg -version
   ```

You should see version information, not an error.

### Troubleshooting

- **"command not found" after installing Node.js** — Close and reopen your terminal (Ubuntu) or PowerShell (Windows). The system needs to reload the list of available commands.
- **"EACCES permission denied" on Ubuntu when installing Forge globally** — Run `sudo pnpm add -g @warpgogol/forge` instead.
- **"corepack: command not found"** — Your Node.js version is too old. Install Node.js 22+ using the steps above.
- **Windsurf can't find `forge`** — Close and reopen Windsurf after installing Forge. IDEs need to restart to pick up new global commands.
- **AI agent doesn't know about Forge** — You opened an empty folder, but the AI agent has no Forge context. Run `forge create my-project --profile editframe` (or the appropriate profile) in a terminal first, then open the created folder in your IDE. The `forge create` command populates the folder with skills, configuration, and `AGENTS.md` — without it, the AI agent can't discover Forge.

---

## Quick start

### For creative operators — one command, then just talk

You need to run one command in the terminal to create your project. After that, everything works through conversation with an AI agent — no more commands.

#### Start a new project from scratch

1. **Create a Forge project.** Open a terminal (PowerShell on Windows, Terminal on Ubuntu) and run:

   ```sh
   forge create my-brand-video --profile editframe
   ```

   Replace `my-brand-video` with your project name (lowercase letters and hyphens). This creates a new folder with everything Forge needs — skills, configuration, and project structure. For other project types, use a different `--profile`:

   | What you want to build                    | Profile flag                           |
   | ----------------------------------------- | -------------------------------------- |
   | Video (brand video, intro, motion design) | `--profile editframe`                  |
   | Website (landing page, blog, portfolio)   | `--profile astro-typescript-turborepo` |
   | Browser game (2D, arcade, puzzle)         | `--profile phaser-turborepo`           |
   | Library or governance-only project        | `--profile forge-shell`                |

2. **Open the project folder in your AI IDE.** Open the folder that was created in step 1 in Windsurf or your preferred IDE.

3. **Tell the AI agent what you want to build.** Just type it in the chat, in your own words. For example:

   > I want to create a brand video for my coffee shop. It should have an animated logo, a short intro, and a product showcase.

   Or:

   > I want to build a website for my photography studio.

   Or:

   > I want to make a browser game where you catch falling stars.

   Or:

   > I want to create a TypeScript library for calculating astrology charts.

   That's it. The AI agent will do everything else:
   - Set up the project structure based on what you described (video, website, game, library, etc.)
   - Configure language preferences and project settings
   - Start a live preview so you can see your work (for websites, games, and videos)
   - Tell you the URL to open in your browser

4. **Watch the preview.** For websites, games, and videos, the AI agent will give you a localhost link. Click it — your project is already running. As you describe changes, the agent updates the project and the preview refreshes automatically.

   For governance and library projects, there's no visual preview — the agent will set up the project structure and tell you when it's ready.

5. **Create together.** From here on, you just talk. Want a different color? Want to add a scene? Want to change the music? Want to add a new function to your library? Just say it. The agent handles all the technical work.

#### Bring an existing project into Forge

If you already have a project somewhere else and want to move it into Forge:

1. **Create a Forge project.** Open a terminal and run:

   ```sh
   forge create my-project
   ```

   Then open the created folder in your AI IDE.

2. **Tell the AI agent:**

   > I want to bring my existing project into Forge. It's located at /path/to/my/project.

   The agent will:
   - Detect what kind of project it is (website, video, game, library, etc.)
   - Move all your files into the new Forge project — including hidden files like `.env`
   - Optionally bring your git history
   - Verify everything builds correctly
   - Start a live preview (for visual project types)

#### What if something goes wrong?

Just tell the AI agent. It can check the project's health, fix issues, and explain what happened — all in plain language. You never need to open a terminal or run commands yourself.

---

### For developers — CLI commands

#### Create a new project

```sh
# Create a new project (scaffold + init + skills + AGENTS.md in one command)
forge create my-project

# With a specific stack profile
forge create my-site --profile astro-typescript-turborepo
forge create my-game --profile phaser-turborepo
forge create my-video --profile editframe
forge create my-library --profile forge-shell

```

If Forge is not installed globally, use `pnpm dlx` instead:

```sh
pnpm dlx @warpgogol/forge create my-project
```

#### Bring an existing project into Forge

There is no CLI command for transplant — it is an interactive, AI-guided process:

```sh
# 1. Create a new empty Forge project
forge create my-project

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
forge doctor

# Validate RFCs
forge rfc.validate

# List available skills
forge skill.list
```

## Stack profiles

A stack profile defines the project scaffold: directory structure, dependencies, CI config, and first workspace. Choose a profile with `--profile` when creating a new project.

| Profile | Project type | Description | First workspace | Use case |
| --- | --- | --- | --- | --- |
| `forge-shell` | Governance / library | Minimal Forge shell (default) | — | Governance-only projects, libraries, non-web projects |
| `astro-typescript-turborepo` | Website | Astro + TypeScript + pnpm + Turborepo | `sites/my-site` | Websites, web apps, content-driven sites |
| `phaser-turborepo` | Browser game | Phaser + TypeScript + pnpm + Turborepo | `games/my-game` | Browser games, interactive experiences |
| `editframe` | Video | Editframe React + Vite + TailwindCSS | `compositions/my-first-video` | Video compositions, brand videos, motion design |

The `editframe` profile also supports an **HTML template** (instead of React) for users who prefer web components over JSX. Choose between the two during project setup.

```sh
# List available profiles (after install)
forge profile.validate
```

When you bring an existing project through the `/forge-bootstrap` transplant mode, Forge detects the matching profile automatically by checking for marker files (`astro.config.*`, `phaser.config.*`, `editframe.config.*`, etc.).

## Upgrade flow

When a new version of `@warpgogol/forge` is published, consumers upgrade additively:

```sh
# 1. Install the latest version
pnpm add -g @warpgogol/forge@latest

# 2. Sync skills and binding defaults from the installed version
forge upgrade

# 3. Check project health
forge doctor
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
