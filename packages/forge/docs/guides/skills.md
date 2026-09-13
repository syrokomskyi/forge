# Skills

Forge ships 37 skills: 29 `fo-` skills (Forge's portable skill set), 5 shared skills, and 3 meta skills.

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

Key skill categories:

- **Idea pipeline** — `fo-idea`, `fo-idea-create-rfc`, `fo-idea-create-adr`, `fo-idea-plan`, `fo-idea-implement`
- **Review** — `fo-review`, `fo-fix`
- **Architecture** — `fo-architecture`, `fo-extract-dna`
- **Session** — `fo-session-retro`, `fo-session-save`, `fo-handoff`
- **Knowledge** — `fo-knowledge-distill`
- **Testing** — `fo-add-tests`
- **Grilling** — `grilling` (stress-test plans before implementation)

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

# Validate pack manifests
pnpm exec forge plugin.validate
```

## Extension points

Packs can declare custom Compass contract blocks — source-file markers that `compass.validate` enforces. See the [forge.yaml reference](../reference/forge-yaml.md) for details.
