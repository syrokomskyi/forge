# Contributing to @warpgogol/forge

Forge's canonical source lives in a private monorepo; this repository is the published standalone form, regenerated on every release. Contributions still flow through here:

- **Issues** — open them here. Bug reports, docs inconsistencies, and feature requests are all welcome.
- **Pull requests** — open them here. A maintainer reviews the patch, ports it into the upstream monorepo, and it ships back to this repo in the next release — you're credited in the commit message and release notes.
- **Direct edits to this repo** — small, self-contained fixes (typos, docs, examples) may be merged here directly if they don't conflict with the generated tree; the upstream port happens on the next export regardless.

## What a good patch looks like

- Keep changes small and typed (`pnpm run typecheck`, `pnpm run lint`, `pnpm test` must pass).
- `src/` is portable — no `@warpgogol/*` imports; helpers accept `io?: WorkspaceIO` as an optional type-only parameter.
- Skills live in `skills/` (canonical source) — never edit `.agents/skills/` twins.
- New commands are registered in `src/command-modules.ts` `loadForgeCommandModules()` — a module not listed there is unreachable via `forge <cmd>`.

## Development setup

```sh
git clone https://github.com/syrokomskyi/forge.git
cd forge
pnpm install
pnpm run build
pnpm test
```

Requires Node.js 24.x (`engines` declares `>=24 <25`) and pnpm.

## Security

See [SECURITY.md](SECURITY.md) — report vulnerabilities privately, not in public issues.
