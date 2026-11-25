# Forge

**Repository-native governance for AI-assisted software development** — project contracts, RFCs, ADRs, agent skills, and deterministic validation.

This monorepo is the canonical authoring home of the Forge platform:

| Package | npm | Role |
| --- | --- | --- |
| `packages/forge` | `@warpgogol/forge` | core runtime, CLI, plugin SDK |
| `packages/forge-typescript` | `@warpgogol/forge-typescript` | TypeScript stack plugin |
| `packages/forge-astro` | `@warpgogol/forge-astro` | generic Astro stack + quality gates |
| `packages/forge-repo-extract` | `@warpgogol/forge-repo-extract` | standalone-repo extraction plugin |
| `packages/forge-system` | `@warpgogol/forge-system` | multi-product coordination plugin |

Packages publish independently versioned lines under npm trusted publishing (OIDC). The repository is self-hosted: it is managed by the npm-published `@warpgogol/forge` artifact and bumps its own pin after each release.

## Provenance

The git history of `packages/forge` and `packages/forge-typescript` is filter-imported with original authorship and dates from the Werkstatt monorepo, where Forge was authored through v9 (`@warpgogol/forge@9.7.1`). The v10 line is a clean re-architecture: no backward compatibility with v9, concepts preserved, mechanics rewritten. Governing design: Werkstatt RFC-1645 (program umbrella) with child designs RFC-1646/1647/1648/1649; the migrated governance line restarts in this repository.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Node.js 24+ required.
