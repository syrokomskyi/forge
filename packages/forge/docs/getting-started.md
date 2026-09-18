# Getting started

## Prerequisites

- **Node.js** 24 or newer — [download from nodejs.org](https://nodejs.org)
- **pnpm** — enable with `corepack enable pnpm` after installing Node.js
- An AI-powered IDE — Windsurf, Cursor, Claude Code, Codex CLI, or any IDE that supports AI agents

## Create a new project

```sh
mkdir my-project
cd my-project
pnpm dlx @warpgogol/forge@latest create --in-place --profile typescript
```

The project name is derived from the folder name. Override with `--name`.

## Open in your IDE

Open the project folder in your AI IDE. The agent reads `AGENTS.md` automatically and discovers Forge skills, RFC workflows, and validators.

## Tell the agent what to build

Just describe what you want in plain language:

> I want to build a TypeScript library for calculating astrology charts.

The agent will set up the project structure, configure settings, and tell you when it's ready.

## Verify project health

```sh
pnpm exec forge doctor
```

This checks that your project contract, skills, RFC registry, ADR registry, and bindings are all healthy.

## Next steps

- [Why Forge?](concepts/why-forge.md) — understand the philosophy
- [Project contract](concepts/project-contract.md) — learn about `forge.yaml`
- [RFC and ADR workflows](guides/rfc-adr.md) — start making decisions
- [CLI reference](reference/cli.md) — all commands
