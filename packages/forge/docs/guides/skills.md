# Skills

Forge ships 41 skills: 34 `fo-` skills (Forge's portable skill set), 4 shared skills, and 3 meta skills. The `skills/` tree also carries support material that is not itself a skill — reference documents under `skills/_shared/` (e.g. the agent operating model that skills include by reference) and the `skills/shared/knowledge/` data directory.

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

# Validate pack manifests
pnpm exec forge plugin.validate
```

## Extension points

Packs can declare custom Compass contract blocks — source-file markers that `compass.validate` enforces. See the [forge.yaml reference](../reference/forge-yaml.md) for details.
