# Changelog

All notable changes to `@warpgogol/forge` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the full commit history, see the [GitHub releases page](https://github.com/syrokomskyi/forge/releases).

## [5.1.1] — 2026-09-18

### Fixed

- `forge.agents.generate` and nested AGENTS.md generation silently produced degraded output in the published package: root and behavioral-layer templates were resolved via `import.meta.dirname`, which points at `dist/src/onboarding/` in compiled code — but `tsc` never copies `.md` assets into `dist/`. Templates and stack profiles are now resolved via `resolveForgePackageRoot`, which walks up to the package root and finds the shipped `src/onboarding/templates/` and `profiles/` directories in both source and compiled layouts
- CHANGELOG backfilled for 4.2.0 – 5.1.0

## [5.1.0] — 2026-09-17

### Changed

- RFC-1105: dissolved the `share/` namespace — promoted domain modules and rewrote all consumers to the new subpaths
- `validator.inventory.generate` now builds the full workspace registry (the manifest fast-path produced a single-module actualState)
- `compass` scan-root resolution: `--package` alone now implies the `--packages` scope (previously a silent no-op that scanned the whole repo)

### Fixed

- Test suite repairs after the RFC-1105/RFC-1096 refactors: systemManifestSchema fixtures (RFC-1106), compass excludedPaths policy, banned-literal scan, heavy-test timeouts

## [5.0.0] — 2026-09-16

### Changed

- **Breaking:** Compass header contract v2 (RFC-1094, RFC-1097) — `KEY_DECISIONS` block, compressed `CHANGE_SUMMARY` with history window, canonical block order, `--mode` flag on `compass.validate`. Repositories must run `compass.migrate` to rewrite v1 headers
- RFC-1095: `compass.summary.record` appends governance-ID items to `CHANGE_SUMMARY` at commit time; `compass.summary.trim` rewritten with repair support
- RFC-1096: all Compass policy values (scan roots, extensions, ignored dirs, test patterns, layer/risk rules, workspace-kind map, exclusion globs, governance-ID and boilerplate regexes) externalized into stack profiles and consumer `forge.yaml` `bindings.compass` overrides

### Added

- `compass.migrate` codemod — mechanical v1 → v2 header migration across a workspace (RFC-1097)

## [4.2.3] — 2026-09-15

### Added

- `forge.file-size.lint` command ported into forge (RFC-1088); SURFACE-01 threshold raised

### Changed

- RFC-1094: Compass header contract v2 — `KEY_DECISIONS`, compressed `CHANGE_SUMMARY`, `--mode` flag
- Standalone CLI now registers all 16 modules — `adr`, `plan`, `audit`, `mission`, `spec`, `program`, `plugin` were previously unreachable via `forge <cmd>`
- vitest `maxWorkers` limited to 50% across packages
- TypeScript pinned to `~5.9.3` (typescript-eslint incompatible with TS 7)
- Dependency updates to latest versions

### Removed

- RFC-1089: forge re-export shims removed from werkstatt-site

## [4.2.2] — 2026-09-13

### Fixed

- Restored Warpgogol attribution line in READMEs

## [4.2.1] — 2026-09-13

### Fixed

- Resolved lint errors (unused vars, `as any` casts)

## [4.2.0] — 2026-09-13

### Added

- `README.uk.md` — Ukrainian readme with agent-based installation instructions
- Agent list restored in Quick start sections

### Changed

- Homepage updated to https://forge.warpgogol.com (RFC-1082)

## [4.1.6] — 2026-09-12

### Changed

- Rewritten README with new positioning: "AI can write the code. Forge keeps the project engineered."
- Restructured documentation into `docs/` with concepts, guides, reference, and maintainers sections (RFC-1080)
- Updated `package.json` description and keywords to reflect repository-native governance positioning

### Added

- `docs/` directory with 13 documentation files
- `CONTRIBUTING.md` — contributor guide
- `SECURITY.md` — security policy
- `CHANGELOG.md` — this file
- `forge public-surface.validate` command — consistency check for README/package.json alignment

### Fixed

- Removed "dependency-free" claim from README (package has runtime dependencies: `yaml`, `zod`, `ajv`, `picomatch`, `trash`, `@aws-sdk/client-s3`)
- Removed Node.js v22.x references from README (package requires `>=24 <25`)
- Removed contradictory "No programming, no terminal, no commands" claim

### Removed

- Deleted stale `warpgogol-forge-2.15.0.tgz` from package root
