# Stack profiles

A stack profile defines the project scaffold: directory structure, dependencies, CI config, and first workspace.

## Available profiles

| Profile | Project type | First workspace | Use case |
| --- | --- | --- | --- |
| `forge-shell` | Governance / library | — | Governance-only projects, libraries, non-web projects |
| `typescript-turborepo` | TypeScript library | — | Generic TypeScript Turborepo monorepo with validators |
| `phaser-turborepo` | Browser game | `games/my-game` | Browser games, interactive experiences |
| `godot-csharp` | Godot game | `games/my-game` | Desktop/mobile games, Godot-based projects |
| `knowledge-typescript-turborepo` | Knowledge system | `knowledge/my-kb` | Evidence-backed knowledge bases |

## Using a profile

```sh
pnpm dlx @warpgogol/forge@latest create --in-place --profile phaser-turborepo
```

## Listing profiles

```sh
pnpm exec forge profile.validate
```

## Auto-detection during transplant

When bringing an existing project through the `/forge-bootstrap` transplant mode, Forge detects the matching profile by checking for marker files:

- `phaser.config.*` → `phaser-turborepo`
- `project.godot` → `godot-csharp`
- `tsconfig.json` + `pnpm-workspace.yaml` → `typescript-turborepo`

## Project-agnostic

Forge is project-agnostic. Stack profiles provide ready-made starting points, but the governance layer (RFCs, ADRs, skills, validators) works the same regardless of the profile.
