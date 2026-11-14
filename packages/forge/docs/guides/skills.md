# Skills

Forge ships <!-- forge:skills-count -->41 skills (34 fo + 4 shared + 3 meta)<!-- /forge:skills-count --> — the `fo-` skills are Forge's portable skill set, shared skills are cross-cutting, and meta skills author other skills. The `skills/` tree also carries support material that is not itself a skill — reference documents under `skills/_shared/` (e.g. the agent operating model that skills include by reference) and the `skills/shared/knowledge/` data directory.

## How skills work

Each skill is a directory under `skills/` containing a `SKILL.md` file with standardized frontmatter:

```yaml
---
name: fo-idea
description: "Classify an idea and route it to RFC, ADR, or direct implementation."
category: idea
concerns: [rfc, adr]
dependsOn: []
---
```

The AI agent reads skill descriptions and invokes skills based on the user's request. Skills are deployed to `.agents/skills/` by `forge create` and synced by `forge upgrade`.

## Built-in skills

<!-- forge:skills-inventory -->

**41 skills** — 34 fo, 4 shared, 3 meta.

- **fo (34):** `fo-add-tests`, `fo-architecture`, `fo-compass-annotate`, `fo-design-summit`, `fo-doc-audit`, `fo-doctor`, `fo-explore`, `fo-extract-dna`, `fo-fix`, `fo-handoff`, `fo-harvest`, `fo-idea`, `fo-idea-audit`, `fo-idea-create-adr`, `fo-idea-create-rfc`, `fo-idea-enhance`, `fo-idea-i-just-want-to-see-the-plan`, `fo-idea-i-just-want-to-see-the-result`, `fo-idea-implement`, `fo-idea-plan`, `fo-idea-status`, `fo-knowledge-distill`, `fo-memory-sync`, `fo-outbox`, `fo-qa`, `fo-reproduce`, `fo-review`, `fo-session-retro`, `fo-session-save`, `fo-spec-ingest`, `fo-step-commit`, `fo-system-dispatch`, `fo-task-run`, `fo-triage`
- **shared (4):** `grilling`, `my-preferences`, `windows-ai-tooling`, `writing-great-skills`
- **meta (3):** `forge-bootstrap`, `port-to-forge`, `skill-create`

<!-- /forge:skills-inventory -->

### How they're organized

Skill categories:

- **Idea pipeline** — `fo-idea`, `fo-idea-audit`, `fo-idea-create-rfc`, `fo-idea-create-adr`, `fo-idea-plan`, `fo-idea-enhance`, `fo-idea-implement`, `fo-idea-status`, plus the two shortcut skills `fo-idea-i-just-want-to-see-the-plan` / `-result`
- **Review** — `fo-review`, `fo-fix`, `fo-architecture`, `fo-design-summit`
- **Architecture & DNA** — `fo-extract-dna`, `fo-compass-annotate`
- **Session & memory** — `fo-session-retro`, `fo-session-save`, `fo-handoff`, `fo-memory-sync`
- **Knowledge** — `fo-knowledge-distill`
- **Testing & triage** — `fo-add-tests`, `fo-reproduce`, `fo-triage`, `fo-qa`
- **Exploration & specs** — `fo-explore`, `fo-spec-ingest`
- **System dispatch** — `fo-system-dispatch`, `fo-task-run`, `fo-outbox`
- **Process helpers** — `fo-step-commit`, `fo-doc-audit`, `fo-harvest`, `fo-doctor`
- **Shared** — `grilling` (stress-test plans before implementation), `my-preferences`, `windows-ai-tooling`, `writing-great-skills`
- **Meta** — `forge-bootstrap`, `port-to-forge`, `skill-create`

## Project-local skill packs

Projects can declare custom skill packs in `forge.yaml`:

```yaml
skillPacks:
  - prefix: wg
    dir: packages/my-skills/skills
```

Each pack directory must contain a `forge.plugin.yaml` manifest. Pack skills use the pack prefix (e.g. `wg-deploy`) and cannot use the reserved `fo-` prefix.

## Validation

```sh
# Validate all skills (including pack skills)
pnpm exec forge skill.validate

# List all skills (pack skills annotated with pack:<prefix>)
pnpm exec forge skill.list

# Re-render marked skill regions in docs / fail on stale skill-count claims
forge skill.doc-sync [--write]

# Validate pack manifests
pnpm exec forge plugin.validate
```

## Extension points

Packs can declare custom Compass contract blocks — source-file markers that `compass.validate` enforces. See the [forge.yaml reference](../reference/forge-yaml.md) for details.
