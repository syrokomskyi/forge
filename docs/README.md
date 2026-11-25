# Governance — clean v10 line

This repository starts a clean governance line at v10. The v9 governance corpus (RFC-0001…RFC-1649) remains in the Werkstatt monorepo as historical provenance — it is not copied wholesale.

## Migration provenance

The program that re-architects Forge is governed by five Werkstatt RFCs (authored 2026-11-25, accepted):

- **RFC-1645** — program umbrella: rearchitect Forge as an autonomous, self-hosted, public platform with first-party plugins
- **RFC-1646** — contract/evidence graph schema
- **RFC-1647** — transactional integration queue + on-demand drain
- **RFC-1648** — plugin SDK + capability model
- **RFC-1649** — this monorepo conversion

Curated migration: v9 RFCs/ADRs/frictions/knowledge that remain load-bearing are migrated here individually, with recorded provenance, as part of the protection migration map (program WP-3). Nothing migrates silently and nothing is lost silently — the migration map is the accounting instrument.
