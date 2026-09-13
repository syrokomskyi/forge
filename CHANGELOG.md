# Changelog

All notable changes to `@warpgogol/forge` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the full commit history, see the [GitHub releases page](https://github.com/syrokomskyi/forge/releases).

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
