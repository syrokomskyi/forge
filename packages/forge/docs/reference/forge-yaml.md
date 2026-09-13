# forge.yaml reference

## Full schema

```yaml
schema: forge/config@1
project:
  name: my-project          # Required. Project name.
  stack: [typescript]        # Required. List of stack identifiers.
  packageManager: pnpm      # Required. Currently only "pnpm" is supported.
paths:
  rfcsDir: docs/rfcs         # Default: docs/rfcs
  adrsDir: docs/adrs         # Default: docs/adrs
  skillsDir: .agents/skills  # Default: .agents/skills
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
skillPacks:
  - prefix: wg
    dir: packages/my-skills/skills
plugins: []
syncedVersion: 4.1.6
```

## project

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | yes | Project name, used in generated AGENTS.md and CI |
| `stack` | string[] | yes | Stack identifiers (e.g. `[typescript]`, `[phaser]`) |
| `packageManager` | string | yes | Package manager (`pnpm` only) |

## paths

| Field | Default | Description |
| --- | --- | --- |
| `rfcsDir` | `docs/rfcs` | Directory for RFC files |
| `adrsDir` | `docs/adrs` | Directory for ADR files |
| `skillsDir` | `.agents/skills` | Directory for deployed skills |

## bindings.commands

A map of named commands to shell strings. The agent uses these to run project-specific operations. Placeholders like `{id}` are substituted at resolve time.

```yaml
bindings:
  commands:
    validateRfc: "forge rfc.validate {id} --json"
    typecheck: "pnpm run build:check"
    test: "pnpm test"
```

## bindings.paths

Additional path bindings that the agent can reference:

```yaml
bindings:
  paths:
    invariantsFile: docs/architecture-dna.md
```

## bindings.terminology

Maps generic terms to project-specific names:

```yaml
bindings:
  terminology:
    invariants: DNA
```

## skillPacks

Optional. Declares project-local skill packs:

```yaml
skillPacks:
  - prefix: wg               # Cannot be "fo" (reserved)
    dir: packages/my-skills/skills
```

Each pack directory must contain a `forge.plugin.yaml` manifest with `id` and `version` fields.

## Extension points

Packs can declare custom Compass contract blocks:

```yaml
# In forge.plugin.yaml
extensionPoints:
  compass:
    contract:
      blocks:
        - blockId: api-contract
          requiredFor:
            - "packages/my-pack/**/*.ts"
          requiredTags:
            - name: purpose
              minWords: 3
```

`compass.validate` enforces these blocks with `COMPASS-PLUGIN-01` (missing block), `COMPASS-PLUGIN-02` (missing tag), and `COMPASS-PLUGIN-03` (below minWords) diagnostics.

## syncedVersion

Set by `forge upgrade`. Tracks the last synced Forge version. Do not edit manually.
