# @warpgogol/forge

[Українська](README.uk.md) | English

**AI can write the code. Forge keeps the project engineered.**

A repository-native control layer for AI-assisted development. Decisions, rules, skills and verification stay with the project — independent of the agent that works on it.

[![npm version](https://img.shields.io/npm/v/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![npm downloads](https://img.shields.io/npm/dm/@warpgogol/forge.svg)](https://www.npmjs.com/package/@warpgogol/forge) [![CI](https://github.com/syrokomskyi/forge/actions/workflows/ci.yml/badge.svg)](https://github.com/syrokomskyi/forge/actions) [![Node](https://img.shields.io/badge/Node-24%2B-green.svg)](https://nodejs.org) [![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

---

## Quick start

```sh
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript-turborepo
```

Then open the project in your AI IDE (Windsurf, Cursor, Claude Code, Codex CLI, or any IDE that supports AI agents) and tell the agent what you want to build.

One bootstrap command. After that, work through your coding agent.

### Stack profiles

Forge is project-agnostic. Stack profiles provide ready-made starting points.

| Profile                          | Use case                                              |
| -------------------------------- | ----------------------------------------------------- |
| `forge-shell`                    | Governance-only projects, libraries, non-web projects |
| `typescript-turborepo`           | TypeScript monorepo with best-practice validators     |
| `phaser-turborepo`               | Browser games, interactive experiences                |
| `godot-csharp`                   | Desktop/mobile games with Godot 4.x + C#              |
| `knowledge-typescript-turborepo` | Evidence-backed knowledge bases                       |

```sh
# List available profiles
pnpm exec forge profile.validate
```

---

## Architecture

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

---

## What Forge controls

| Plane              | What it governs                                    |
| ------------------ | -------------------------------------------------- |
| **Intent**         | RFCs, architectural DNA, acceptance criteria       |
| **Decisions**      | ADRs, decision logs, traceability                  |
| **Agent behavior** | Repository-local skills and workflows              |
| **Verification**   | Doctor, validators, contracts, deterministic gates |
| **Evolution**      | Profiles, vendored specs, additive upgrades        |

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

- **37 skills** — idea-to-RFC pipeline, grilling, preferences, skill authoring
- **RFC workflow** — create, validate, list, graph, archive, acceptance probes
- **ADR workflow** — lightweight architectural decision records
- **Spec vendoring** — vendor external specs as immutable snapshots
- **Naming conventions** — kebab-case linting
- **Workflow linting** — validate `.agents/workflows/` frontmatter
- **Stack scaffolding** — pnpm + Turborepo monorepo from a profile
- **Bindings contract** — de-hardcode project-specific commands via `forge.yaml`
- **Doctor** — project health check
- **Upgrade** — additive, idempotent skill and config sync

---

## Working with your AI agent

Forge works with any AI agent — Windsurf, Cursor, Claude Code, Codex CLI, or any IDE that supports agent skills. The setup is the same; only the conversation matters.

**Start with questions, not commands.** Before asking the agent to write code, ask it about the codebase. The agent can read files, search git history, and run Forge CLI commands — let it explore first.

**Describe results, not steps.** Tell the agent what you want, not how to do it. For complex work, ask the agent to plan first and wait for your approval.

**Let the agent verify its own work.** Give criteria for "done" and let the agent check itself: "Run the tests after you're done." "Validate the RFC before committing." "Check project health with `forge doctor`."

**AGENTS.md is your project's persistent memory.** Forge generates `AGENTS.md` files that the agent reads at the start of every session. Put build commands, code style, architecture decisions, and "do X, not Y" rules there.

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

## Programmatic API

```ts
import {
  forgeCoreModule,
  forgeRfcModule,
  loadForgeConfig,
  resolveBinding,
  FORGE_SKILLS,
} from "@warpgogol/forge";

const config = loadForgeConfig(process.cwd());
const cmd = resolveBinding(config, "commands.validateRfc", { id: "RFC-0001" });

const registry = /* your ForgeModuleRegistry */;
await forgeCoreModule.register(registry);
await forgeRfcModule.register(registry);
```

Full API reference: [docs/reference/programmatic-api.md](docs/reference/programmatic-api.md)

---

## Architecture

| Directory | Purpose |
| --- | --- |
| `src/` | Portable core — types, config, skills registry, validators, onboarding. Zero `@warpgogol/*` imports. |
| `os/` | ForgeModule registrations. `compass` and `werkstatt` are fully autonomous — all handlers inlined. |
| `bin/` | CLI entrypoint (`forge` command). |
| `skills/` | 37 skill definitions (29 fo + 5 shared + 3 meta) with SKILL.md frontmatter. |
| `profiles/` | Stack profiles for `scaffold`. |

---

## Upgrade flow

```sh
pnpm update @warpgogol/forge
pnpm exec forge upgrade
pnpm exec forge doctor
```

`forge upgrade` is additive — it never overwrites operator-set bindings, never deletes files, and is idempotent. Use `--dry-run` to preview changes.

---

## Documentation

- [Getting started](docs/getting-started.md)
- [Why Forge?](docs/concepts/why-forge.md)
- [Project contract](docs/concepts/project-contract.md)
- [Governance model](docs/concepts/governance-model.md)
- [Bring an existing project](docs/guides/existing-project.md)
- [Upgrading](docs/guides/upgrading.md)
- [Skills](docs/guides/skills.md)
- [RFC and ADR workflows](docs/guides/rfc-adr.md)
- [CLI reference](docs/reference/cli.md)
- [forge.yaml reference](docs/reference/forge-yaml.md)
- [Profiles](docs/reference/profiles.md)
- [Programmatic API](docs/reference/programmatic-api.md)
- [Publishing](docs/maintainers/publishing.md)

---

## License

Apache-2.0

## Open Engineering

This package originated from production engineering work at [Warpgogol](https://warpgogol.com), an engineering studio in Germany.

We publish reusable parts of our infrastructure when they can be useful beyond our own projects. It is published independently of any Warpgogol commercial service. Using this package does not create any dependency on Warpgogol.

Built for real systems. Shared openly.
