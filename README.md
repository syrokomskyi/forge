# @warpgogol/forge

[Українська](README.uk.md) | English

**AI agents write the code. Forge keeps the project engineered.**

A repository-native control layer for AI-assisted development. Decisions, rules, skills and verification live with the repository — independent of the agent, model or IDE doing the work.

**Proven on itself first.** The monorepo that builds Forge is governed by Forge: 1,500+ RFCs, 130+ ADRs and 41 agent skills — every change merged to main passes deterministic verification gates, not "the agent says it's done". The same layer already governs a ~5.9M-line engineering fleet across 8 repositories. [The measured fleet ↓](#forged-in-production)

> Engineered at [Warpgogol](https://warpgogol.com) · Released as open source. <!-- pkg-health-12: domain name, not a command -->

[![npm version](https://img.shields.io/npm/v/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![npm downloads](https://img.shields.io/npm/dm/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![CI](https://github.com/syrokomskyi/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/syrokomskyi/forge/actions) [![Node](https://img.shields.io/badge/Node-24%2B-green.svg)](https://nodejs.org) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE) <!-- pkg-health-12: domain name, not a command -->

![Cover - Forge](https://raw.githubusercontent.com/syrokomskyi/forge/main/images/cover.webp)

---

## The problem

AI agents made writing code cheap — and keeping a project coherent expensive.

- Rules live in prompts that vanish between sessions.
- Architecture decisions stay implicit — the codebase can't explain _why_ it looks this way.
- "Done" means the agent says so.
- Switching agents, models or IDEs resets the project's memory to zero.

Every additional agent multiplies the drift. Speed without control is technical debt at agent velocity.

## The missing layer

Agents and models are interchangeable parts. The project needs a control layer that isn't.

```
IDE / AGENT / MODEL
       ↓
┌──────────────────────────────────┐
│             FORGE                 │
│                                   │
│ Project contract      forge.yaml  │
│ Decisions             RFC / ADR   │
│ Agent workflows       Skills      │
│ Verification          Validators  │
│ Evolution             Upgrade     │
└──────────────────────────────────┘
       ↓
YOUR REPOSITORY
```

Agents can change. Models can change. IDEs can change. Engineering rules stay with the project.

## One project contract. Multiple agents.

Forge stores engineering rules in portable repository files — `forge.yaml`, `AGENTS.md`, RFCs, skills. Compatible agents can consume the same instructions, decisions, and workflows: **Devin**, Windsurf, Cursor, Claude Code, Codex CLI — and whatever ships next. Deterministic checks remain independent of the agent and can be enforced through CI. No per-vendor plugin, no lock-in.

This makes autonomous development easier to inspect and verify: deterministic gates check declared invariants, while session audits identify potential policy violations and produce reviewable findings. For Devin CLI / Devin Cloud specifics — install order, a one-task walkthrough, and honest boundaries — see [docs/integrations/devin.md](docs/integrations/devin.md).

---

## Start right now

Create a new folder, open it in your AI IDE or point your coding agent at it, and paste this:

```
Install https://npmjs.com/package/@warpgogol/forge in this folder and set up my project. I want to build: [describe your project]
```

Replace `[describe your project]` with your idea — a game, a library, a knowledge base, anything. The AI agent installs Forge, scaffolds the project, and — for profiles that ship a runnable surface — sets up a live preview. From there on, you just talk: describe what you want, and the agent builds it. No programming, no terminal, no commands.

This workflow requires an agent with filesystem and command-execution access, a compatible environment (Node.js 24+, pnpm), and permission to install dependencies.

### After the prompt completes — the Bootstrap skill

Once the AI agent has installed Forge and scaffolded your project, it will run the `/forge-bootstrap` skill. This is a required step that configures your project interactively:

- The language the AI uses to communicate with you
- The language for project documentation (RFCs, ADRs, READMEs) — defaults to English
- Your preferred working style — business or creative
- Your name and how you want to be addressed
- Your stack configuration (or migration of an existing project)

The skill asks a few simple questions in the chat, then sets everything up. After it completes, you're ready to create — just tell the AI agent what you want to build.

---

## Quick start (terminal)

```sh
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript
```

Then open the project in your AI IDE or hand it to your coding agent and describe what you want to build. One bootstrap command — after that, work through your agent.

### Stack profiles

Forge is project-agnostic. Stack profiles provide ready-made starting points.

| Profile         | Use case                                              |
| --------------- | ----------------------------------------------------- |
| `forge-shell`   | Governance-only projects, libraries, non-web projects |
| `typescript`    | TypeScript monorepo with best-practice validators     |
| `phaser-game`   | Browser games, interactive experiences                |
| `godot-game`    | Desktop/mobile games with Godot 4.x + C#              |
| `knowledge`     | Evidence-backed knowledge bases                       |
| `site-workshop` | Per-client Werkstatt workshops                        |

```sh
# List available profiles
pnpm exec forge profile.validate
```

---

## What Forge controls

| Plane              | What it governs                                    |
| ------------------ | -------------------------------------------------- |
| **Intent**         | RFCs, architectural DNA, acceptance criteria       |
| **Decisions**      | ADRs, decision logs, traceability                  |
| **Agent behavior** | Repository-local skills and workflows              |
| **Verification**   | Doctor, validators, contracts, deterministic gates |
| **Evolution**      | Profiles, vendored specs, additive upgrades        |

Instructions, validation and enforcement are distinct levels — see [the verification model](docs/concepts/verification-model.md) for what Forge does and does not guarantee.

---

## Without Forge / With Forge

| AI development without Forge          | With Forge                                       |
| ------------------------------------- | ------------------------------------------------ |
| Rules live in prompts                 | Rules live in the repository                     |
| Architecture is implicit              | Decisions become RFCs and ADRs                   |
| Agent behavior depends on the session | Project-local skills define repeatable workflows |
| "Done" means the agent says so        | Validators provide deterministic checks          |
| New agent starts from zero            | Project contract travels with the code           |
| Upgrades risk overwriting decisions   | Upgrade is additive and idempotent               |
| Tool-specific conventions             | Agent- and IDE-independent project layer         |

---

## Forge IS / Forge IS NOT

**Forge IS**

- A repository-native governance layer
- Agent-independent project infrastructure
- A deterministic complement to probabilistic AI agents
- A portable project contract

**Forge IS NOT**

- Another AI model
- Another coding agent
- An IDE
- A hosted platform
- A replacement for Git
- A magic "vibe coding" wrapper

---

## What you get

**Decisions & knowledge**

- **RFC workflow** — create, validate, list, graph, archive, acceptance probes
- **ADR workflow** — lightweight architectural decision records
- **Spec vendoring** — vendor external specs as immutable snapshots
- **Trajectory memory** — extract proven procedures from verified sessions and recall them at decision points
- **Context assembly** — budgeted, ranked context slates for a task description

**Agent behavior**

- **41 skills** — the full idea → RFC → plan → implement → review → fix pipeline, grilling, preferences, skill authoring
- **Agent operating model** — EXPLORE/ROUTINE/GOVERNED work modes with explicit authority boundaries (the operator owns intent; the agent owns implementation and escalates rather than guesses at boundaries), a proportionate verification portfolio, and separated completion vocabulary — IMPLEMENTED / VERIFIED / ACCEPTED / RELEASED — shipped as a shared skill and synced by `forge upgrade`
- **Session audit** — deterministic detectors over saved agent sessions: circumvention, blocker deception, false completion claims

**Verification & evolution**

- **Doctor** — project health check
- **Validators** — naming lint, workflow-frontmatter lint, YAML scalar lint, public-surface consistency
- **Gate probes** — prove governance gates still fire on seeded violations
- **Golden conformance** — run producer→consumer contract conformance across declared surfaces
- **Upgrade** — additive, idempotent skill and config sync
- **Stack scaffolding** — pnpm + Turborepo monorepo from a profile
- **Bindings contract** — de-hardcode project-specific commands via `forge.yaml`

---

## Working with your AI agent

Forge works with any AI agent — Devin, Windsurf, Cursor, Claude Code, Codex CLI — because the contract lives in the repository, not in a vendor plugin. The setup is the same everywhere; only the conversation matters.

**Start with questions, not commands.** Before asking the agent to write code, ask it about the codebase. The agent can read files, search git history, and run Forge CLI commands — let it explore first.

**Describe results, not steps.** Tell the agent what you want, not how to do it. For complex work, ask the agent to plan first and wait for your approval.

**Let the agent verify its own work.** Give criteria for "done" and let the agent check itself: "Run the tests after you're done." "Validate the RFC before committing." "Check project health with `forge doctor`." Forge's operating model teaches agents to report IMPLEMENTED vs VERIFIED vs ACCEPTED separately — a claim never outruns its evidence.

**AGENTS.md is your project's persistent memory.** Forge generates `AGENTS.md` files that the agent reads at the start of every session. Put build commands, code style, architecture decisions, and "do X, not Y" rules there.

---

## forge.yaml

The single source of truth for project configuration:

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

Full reference: [docs/reference/forge-yaml.md](docs/reference/forge-yaml.md)

---

## CLI

```sh
# Check project health
pnpm exec forge doctor

# Validate RFCs
pnpm exec forge rfc.validate

# List available skills
pnpm exec forge skill.list

# Sync skills and config from installed version
pnpm exec forge upgrade

# Validate public surface consistency
pnpm exec forge public-surface.validate
```

Full CLI reference: [docs/reference/cli.md](docs/reference/cli.md)

---

## Forged in production

Forge does not govern toy projects — starting with itself. The werkstatt monorepo that builds Forge carries **1,563 RFCs and 131 ADRs** under Forge governance, and every change lands through the deterministic integration gate. The same control layer runs a working engineering fleet — measured 2026-11-13 by Forge's own `codebase.measure` over git-tracked files only (generated, vendored, and mirrored content is classified separately; export mirrors and deployment caches are excluded to avoid double counting).

| Repository | Role | Files | Total | code | tests | docs | generated | Top language |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pipelines | Production document pipeline suite | 22,609 | 3,122,894 | 1,215,172 | 127,237 | 1,747,517 | 32,968 | Markdown |
| werkstatt | The platform monorepo that builds Forge itself | 14,084 | 1,737,825 | 808,969 | 351,999 | 233,302 | 343,555 | TypeScript |
| dater | Production product monorepo | 1,419 | 479,041 | 380,487 | 51,992 | 31,716 | 14,846 | JSON |
| hdri | Client repository | 1,510 | 463,226 | 402,796 | 38,774 | 13,763 | 7,893 | TypeScript |
| lagebild | Client-facing data platform | 486 | 50,096 | 16,660 | 13,319 | 10,774 | 9,343 | TypeScript |
| metads | Product monorepo | 283 | 48,011 | 34,096 | 3,310 | 1,456 | 9,149 | TypeScript |
| dialogue-steward | Product monorepo | 288 | 34,698 | 13,935 | 5,666 | 4,665 | 10,432 | TypeScript |
| warpgogol-verbund | System hub — product registry and task queue | 132 | 9,671 | 7,160 | 0 | 1,467 | 1,044 | Other |
| **Fleet total** |  | 40,811 | 5,945,462 | 2,879,275 | 592,297 | 2,044,660 | 429,230 |  |

`Total` decomposes exactly into `code + tests + docs + generated` — every tracked line is classified, none counted twice.

Language rollup across the fleet: Markdown 34.1%, TypeScript 25.3%, JSON 19.1%, YAML 15.3%, XML 3.2% — a fleet where a third of the mass is written knowledge, which is exactly what a governance layer exists to keep coherent.

Symbol counts come from a real TypeScript AST pass — 98,494 symbols measured (1,721 classes, 90,761 functions, 6,012 methods), not regex estimates. Where a workspace resolves a compiler the walker cannot use, the command reports `symbolsSkipped` instead of fabricating numbers.

Measure your own repository:

```sh
pnpm exec forge codebase.measure --json
```

Methodology, a worked example, and limitations: [docs/reference/fleet-measurement.md](docs/reference/fleet-measurement.md). These are self-reported numbers from Forge's own instrument — an instrument reading, not an independent audit.

### One task. One contract. One verified result.

This README is the case study. Version 9.6.1 — including this file — was authored end-to-end by an AI agent under operator direction: the agent rewrote the README, Forge's own commit gate ran scoped checks, the integration gate ran the heavyweight suite, and CI ran lint/typecheck/build/test before `npm publish --provenance`. Every transition produced a verifiable artifact — [release v9.6.1](https://github.com/syrokomskyi/forge/releases/tag/v9.6.1) · [CI runs](https://github.com/syrokomskyi/forge/actions).

---

## Where Forge is going

- **More stack profiles** — governed scaffolding for more ecosystems beyond TypeScript.
- **Deeper session evidence** — trajectory memory, session audit and gate probes growing into a full trust contour for autonomous agents.
- **More contract surfaces** — golden conformance across additional producer→consumer boundaries.

---

## Programmatic API

```ts
import {
  createForgeRfcModule,
  type ForgeLogger,
  type ForgeRuntimeContext,
} from "@warpgogol/forge";

const logger: ForgeLogger = {
  section: console.log,
  info: console.log,
  warn: console.warn,
  error: console.error,
  success: console.log,
};
const context: ForgeRuntimeContext = {
  workspaceRoot: process.cwd(),
  logger,
  dryRun: false,
  outputFormat: "json",
};

const rfcModule = await createForgeRfcModule();
const rfcValidate = rfcModule.commands.find((c) => c.name === "rfc.validate");
const result = await rfcValidate?.execute({ argv: [], flags: {} }, context);
console.log(result?.exitCode); // 0 = pass, 1 = fail
```

Full API reference: [docs/reference/programmatic-api.md](docs/reference/programmatic-api.md)

---

## Architecture

| Directory | Purpose |
| --- | --- |
| `src/` | Portable core — types, config, skills registry, validators, onboarding. Zero `@warpgogol/*` imports. |
| `os/` | ForgeModule registrations. All `os/` modules are autonomous except `werkstatt` — the only adapter importing `@warpgogol/werkstatt-engine`. |
| `bin/` | CLI entrypoint (`forge` command). |
| `skills/` | 41 skill definitions (34 fo + 4 shared + 3 meta) with SKILL.md frontmatter. |
| `profiles/` | Stack profiles for `scaffold`. |

---

## Upgrade flow

```sh
pnpm update @warpgogol/forge
pnpm exec forge upgrade
pnpm exec forge doctor
```

`forge upgrade` is additive — it never overwrites operator-set bindings, is idempotent, and reconciles the generated surface on every run (including same-version noop): synced skill dirs get a `.forge-managed` manifest, stale marked dirs are pruned only when their contents match the manifest, and prettier consumers get a delimited forge-managed block in `.prettierignore` (RFC-1154). Use `--dry-run` to preview changes. Editable generated guides (`AGENTS.md`) are merged, not overwritten: content below the `<!-- forge:custom -->` boundary is preserved verbatim on regeneration (RFC-1153), and `--dry-run` reports `nestedAgentsPlanned` / `nestedAgentsPreserved` / `nestedAgentsSkipped`.

---

## Documentation

- [Getting started](docs/getting-started.md)
- [Why Forge?](docs/concepts/why-forge.md)
- [Project contract](docs/concepts/project-contract.md)
- [Governance model](docs/concepts/governance-model.md)
- [The verification model](docs/concepts/verification-model.md)
- [Bring an existing project](docs/guides/existing-project.md)
- [Upgrading](docs/guides/upgrading.md)
- [Skills](docs/guides/skills.md)
- [RFC and ADR workflows](docs/guides/rfc-adr.md)
- [Verification & evidence scenarios](docs/guides/verification-and-evidence.md)
- [Devin integration](docs/integrations/devin.md)
- [CLI reference](docs/reference/cli.md)
- [forge.yaml reference](docs/reference/forge-yaml.md)
- [Profiles](docs/reference/profiles.md)
- [Programmatic API](docs/reference/programmatic-api.md)
- [Fleet measurement methodology](docs/reference/fleet-measurement.md)
- [Publishing](docs/maintainers/publishing.md)

---

## License

Apache-2.0

## Open Engineering

This package originated from production engineering work at [Warpgogol](https://warpgogol.com), an engineering studio in Germany that ships client products through the same Forge-governed, agent-driven pipeline.

We publish reusable parts of our infrastructure when they can be useful beyond our own projects. It is published independently of any Warpgogol commercial service. Using this package does not create any dependency on Warpgogol.

Built for real systems. Shared openly.
