# Project contract

The project contract is `forge.yaml` — the single source of truth for project configuration. It is created by `forge create` and read by the AI agent at the start of every session.

## Structure

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

## Fields

### project

- `name` — project name (used in generated `AGENTS.md` and CI)
- `stack` — list of stack identifiers (e.g. `[typescript]`, `[phaser]`)
- `packageManager` — `pnpm` (currently the only supported manager)

### paths

- `rfcsDir` — directory for RFC files (default: `docs/rfcs`)
- `adrsDir` — directory for ADR files (default: `docs/adrs`)
- `skillsDir` — directory for skill files (default: `.agents/skills`)

### bindings

- `commands` — map of named commands to shell strings. The agent uses these to run project-specific operations.
- `paths` — additional path bindings (e.g. `invariantsFile` for architecture DNA)
- `terminology` — maps generic terms to project-specific names (e.g. `invariants: DNA`)

### skillPacks

Optional. Declares project-local skill packs:

```yaml
skillPacks:
  - prefix: wg
    dir: packages/my-skills/skills
```

## What the agent sees

The agent reads `forge.yaml` and `AGENTS.md` at session start. `forge.yaml` tells it how to run commands; `AGENTS.md` tells it project rules and conventions. Together, they form the project contract that travels with the code.
