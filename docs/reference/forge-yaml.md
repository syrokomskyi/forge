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

| Field            | Type     | Required | Description                                         |
| ---------------- | -------- | -------- | --------------------------------------------------- |
| `name`           | string   | yes      | Project name, used in generated AGENTS.md and CI    |
| `stack`          | string[] | yes      | Stack identifiers (e.g. `[typescript]`, `[phaser]`) |
| `packageManager` | string   | yes      | Package manager (`pnpm` only)                       |

## paths

| Field       | Default          | Description                   |
| ----------- | ---------------- | ----------------------------- |
| `rfcsDir`   | `docs/rfcs`      | Directory for RFC files       |
| `adrsDir`   | `docs/adrs`      | Directory for ADR files       |
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

## bindings.compass

Optional. Consumer-level Compass policy overrides (RFC-1096). The same shape is available to stack profiles via their `compass:` section — resolution order is generic defaults → profile `compass:` → `bindings.compass`.

```yaml
bindings:
  compass:
    fileExtensions: [.ts, .tsx, ".svelte", "!.astro"]
    testPatterns: ["**/*.test.ts", "test/**"]
    scanRoots: [packages, services]
    ignoredDirs: [spec, todo]
    ignoredDirPrefixes: ["old-", "-"]
    highRiskPaths: ["packages/engine/src/kernel/**"]
    idPattern: "\\b([A-Z][A-Z0-9]*-)+\\d+\\b"
    purposeBoilerplatePatterns: ["^(this file|the file)\\b"]
    layerRules:
      - { pattern: "src/pages/**", layer: page, risk: medium }
    workspaceKinds: { apps: app, packages: package, services: service }
    excludedPaths:
      - { pattern: "src/templates/**", reason: template-source }
```

Merge semantics per key:

- **Union-merge** (`fileExtensions`, `testPatterns`, `ignoredDirs`, `ignoredDirPrefixes`, `highRiskPaths`, `excludedPaths`): values merge with the generic defaults; an entry prefixed with `!` removes it (for `excludedPaths`, `!` matches on `pattern`).
- **Replace** (`scanRoots`, `idPattern`, `purposeBoilerplatePatterns`, `layerRules`, `workspaceKinds`): the consumer value replaces the whole list — repeat generic entries you still need.

`idPattern` must compile and match the `NAMESPACE-NUMBER` probe `ABC-123`, otherwise `resolveCompassPolicy` throws `CompassPolicyConfigError` naming the key. `layerRules` are evaluated first-match on the workspace-relative path; `highRiskPaths` are picomatch globs on the root-relative path that force `riskClass: high`. `excludedPaths` mark matching files `authoringStatus: excluded` with the given `reason` (they are still inventoried).

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
