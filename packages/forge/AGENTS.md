# @webgogol/forge Agent Guide

Portable governance skills and command modules extracted from site-kernel (RFC-0374).

## Architecture

- `src/` — portable, no kernel imports. Contains skill schema, registry, validators, onboarding handlers, config module, canonical types, and utilities.
- `os/` — kernel-optional. Contains ForgeModule registrations. In Warpgogol mode, `os/` modules can dynamically import `@warpgogol/site-kernel-checks`, `@warpgogol/site-kernel-codegen`, `@warpgogol/site-kernel-handoff`. In autonomous mode, those imports gracefully fail and only forge-native commands are registered.
- `bin/` — CLI entrypoint (`forge` command) for autonomous usage without `@warpgogol/site-kernel`.
- `skills/` — forge-managed skill definitions (22 fo skills + 4 shared + 3 meta = 29 skills). Project-declared skill packs (RFC-0539) live outside forge and are discovered via `discoverPackSkills` from `forge.yaml` `skillPacks` config.

## OS modules

| Module | Commands | Source |
| --- | --- | --- |
| `forgeCoreModule` | `forge.create`, `forge.doctor`, `forge.upgrade`, `forge.agents.generate`, `forge.scaffold`, `forge.port.scaffold`, `forge.skill.validate`, `forge.skill.list`, `forge.port.validate`, `docs.archive` | `os/core/` |
| `forgeRfcModule` | `rfc.list`, `rfc.validate`, `rfc.create`, etc. | `os/rfc/` |
| `forgeWorkflowModule` | `workflow.lint`, `workflow.list`, `workflow.amend.list` | `os/workflow/` |
| `forgeNamingModule` | `naming.convention.lint` | `os/naming/` |
| `forgeCompassModule` | `compass.inventory`, `compass.validate`, `compass.summary.trim`, etc. (8 commands) | `os/compass/` |
| `forgeWerkstattModule` | `werkstatt.lock.status`, `werkstatt.lock.recover`, `werkstatt.operation.validate` | `os/werkstatt/` |
| `forgeSpecModule` | `spec.validate`, `spec.status`, `spec.materialize` | `os/spec/` |
| `forgeAdrModule` | `adr.list`, `adr.create`, `adr.validate`, `adr.archive` | `os/adr/` |
| `forgePlanModule` | `plan.archive` | `os/plan/` |
| `forgeAuditModule` | `audit.archive` | `os/audit/` |
| `forgeSessionModule` | `session.save`, `session.archive`, `session.validate`, `session.list` | `os/session/` |

## Archive convention

When archiving terminal artifacts, prefer the `docs.archive` umbrella command over individual `rfc.archive`, `adr.archive`, `plan.archive`, `audit.archive`, `session.archive` commands. The umbrella command runs all five in sequence and prevents leaving audits/plans/sessions unarchived when the operator's intent is to clean up all terminal artifacts. Use individual commands only when the operator explicitly asks for a single domain (e.g. "archive only RFCs").

## Skills

Skills live in `skills/` and are synced to `.agents/skills/` by `forge.create`. Each skill has a `SKILL.md` with standardized frontmatter (name, description, category, concerns, dependsOn).

The `concerns` field uses a four-level taxonomy (RFC-0523): `read-only` (no file modifications), `document-only` (modifies `.md` files only), `content-mutation` (modifies content `.md`/`.yaml` but not executable code), `code-mutation` (modifies `.ts`/`.astro` code). `forge.skill.validate` enforces this via SKILL-12.

The optional `knowledge` field (RFC-0524) declares cumulative knowledge files as an array of file names relative to the SKILL.md directory (e.g. `knowledge: [qa-log.md, learned-principles.md]`). `forge.skill.validate` enforces SKILL-13: declared knowledge files must exist. `forge.create` syncs them to `.agents/skills/`. `forge.doctor` detects stale copies. See `writing-great-skills` § Cumulative knowledge pattern for the three-layer reference pattern and mutation contract.

### Skill packs (RFC-0539)

Project-declared skill packs allow projects to manage their own skills under a project-specific prefix, separate from forge's portable `fo-` skills. Packs are declared in `forge.yaml` under `skillPacks`:

```yaml
skillPacks:
  - prefix: wg
    dir: packages/warpgogol-skills/skills
```

- `forge.create` syncs pack skills alongside forge skills into `.agents/skills/`.
- `forge.skill.validate` validates pack skills with SKILL-01..13 plus SKILL-14 (pack skill name must start with pack prefix), SKILL-15 (non-forge skill may not use `fo-` prefix), and SKILL-17 (no platform RFC/ADR ids or platform names).
- SKILL-07 enforces asymmetric dependency direction: pack skills may depend on forge skills, but forge skills may not depend on pack skills (breaks portability).
- `forge.skill.list` includes pack skills with `pack:<prefix>` annotation.
- `forge.doctor` checks for stale/missing pack skill copies and validates `skillPacks` config (unique prefixes, unique dirs, no `fo` prefix, dir exists).
- **RFC-0552:** `forge.create` (via `runInit`) and `forge.upgrade` (via `syncPackSkills`) detect pack skills whose name conflicts with a Forge skill name. Conflicting pack skills are skipped (not copied to `.agents/skills/`) and reported in `skippedSkills` on `InitResult` and `UpgradeResult`. The `forge-bootstrap` skill reports skipped skills to the operator during onboarding. The `forge-bootstrap` skill also runs `git init` for greenfield projects without a `.git` directory and commits synced skills to git.

## Import rules

- `src/` must NOT import from `@warpgogol/site-kernel` or any kernel package.
- `os/` MAY dynamically import `@warpgogol/site-kernel-checks`, `@warpgogol/site-kernel-codegen`, `@warpgogol/site-kernel-handoff` (wrapped in try/catch for autonomous mode).
- Apps import forge modules from `@webgogol/forge` (the package entrypoint re-exports all OS modules).

## forge.yaml (RFC-0391)

`forge.yaml` is the machine-readable project configuration file at the project root. It records project name, stack, package manager, and docs paths. `forge.create` creates it; `forge.doctor` checks for it; `forge.agents.generate` reads it to produce `AGENTS.md`.

- **MUST NOT** run `forge.agents.generate` against this monorepo's root `AGENTS.md` — it is hand-written and carries no generated marker; the edit guard enforces this, do not bypass it.
- **MUST NOT** re-add any `@warpgogol/*` import to `packages/forge` source — `forge.doctor` autonomy guard will fail.
- **MUST NOT** hand-edit a generated `AGENTS.md` in bootstrapped projects — edit `forge.yaml` and regenerate.

## Stack profiles (RFC-0392)

Stack profiles are YAML documents under `profiles/` describing a supported stack (detection markers, workspace layout, install steps, baseline files). `forge.scaffold` creates a working pnpm + Turborepo monorepo from a chosen profile in an empty directory. The migration-adapter registry (RFC-0546) detects the stack of an existing project during `forge-bootstrap` transplant mode.

- **MUST NOT** scaffold into a non-empty directory — no `--force` flag.
- **MUST NOT** add stack profiles for stacks forge cannot scaffold end-to-end.
- Shipped profiles: `astro-typescript-turborepo`, `phaser-turborepo`, `forge-shell` (minimal — default for `forge.create`).

## Bindings contract (RFC-0393)

The `bindings` section in `forge.yaml` de-hardcodes project-specific values from fo-skills. Skills reference bindings by key (e.g. `ref(forge.yaml bindings.commands.validateRfc)`) instead of hardcoding commands, paths, or terminology.

- `forgeBindingsSchema` + `resolveBinding(config, key, placeholders?)` are exported from `@webgogol/forge`.
- `forge.doctor` validates bindings: checks path existence, reports resolved/absent/invalid, and emits `defaultable-binding-null` notices for forge-CLI-backed bindings that are null (RFC-0540).
- `forge.create` writes forge-CLI-backed defaults for commands forge provides (`validateRfc`, `validateAdr`, `implementStamp`, `specValidate`) and null for stack-dependent commands (`typecheck`, `test`, `scopedBuild`). The package manager from `forge.yaml` determines the runner prefix (`pnpm exec`, `npx`, `yarn exec`, `bunx`).
- `forge.skill.validate` enforces SKILL-11: canonical skill bodies must not contain hardcoded `pnpm exec site-kernel run` or `docs/architecture-dna.md` in instruction lines (code blocks and `run:` directives). Supports `<!-- skill-lint-disable SKILL-11 -->` escape hatch.
- `forge.skill.validate` enforces SKILL-17: skill files must not contain specific platform RFC/ADR ids (`RFC-\d{4}`, `ADR-\d{4}`) or platform names ("Warpgogol", "Warpgogol", "WarpGogol"). Generic "RFC"/"ADR" terms, generic placeholder ids (`RFC-XXXX`), file paths (`adr-0000-template.md`), and binding key names (`validateRfc`) are allowed. The `@webgogol/forge` npm package name is excluded from the platform name check. Supports `<!-- skill-lint-disable SKILL-17 -->` escape hatch.
- Skills declare binding requirements in frontmatter: `bindings: { requires: [...], optional: [...] }`.
- Degradation contract: required binding unresolvable → skill refuses to start; optional binding absent → step skipped with `Degraded:` line in report.

## Output contract (RFC-0542)

Every forge CLI command's output ends with a **Next steps** block in pretty mode and a `nextSteps` array in `--json` mode. Each entry is `{ action: string, kind: "required" | "optional" }`.

- `renderNextSteps`, `renderIdeRecommendation`, and `generateHelp` are pure functions in `src/cli-output.ts` — importable by `bin/cli.ts` and unit tests.
- `forge.create` prints an IDE recommendation (Windsurf tested, alternatives without guarantee) after the Next steps block in pretty mode.
- All forge CLI natural-language output is English regardless of `PREFERENCES.md` — `aiLanguage` governs agent chat, not the forge binary.
- `printHelp` is generated from the registry via `generateHelp` — no hand-maintained command list. `--help <command>` prints per-command flags and description.
- `ForgeNextStep` type and `nextSteps?` field are on `ForgeCommandResult` directly (cross-cutting), not inside command-specific `data`.
- Lifecycle commands (`forge.create`, `forge.scaffold`, `forge.doctor`, `forge.port.scaffold`) MUST populate `nextSteps`. Pass-state validators MAY leave the array empty.
- Future commands (`forge.create`, `forge.upgrade`) MUST conform to the `nextSteps` contract from day one.
- Skill reports (agent chat output) use the operator's `aiLanguage` and contain zero CLI commands, guides, or format references in user-facing text. The system hides all complexity from the operator. CLI output remains English per RFC-0542; only the skill (agent chat) uses `aiLanguage`. The `forge-bootstrap` welcoming report is the canonical example of this contract.

## Silent upgrade trigger (RFC-0554)

The `forge-bootstrap` skill step 0 silently checks `forge.syncedVersion` against the installed `@webgogol/forge` version. If they differ, it runs `forge upgrade` invisibly — the operator is never informed about migration, version numbers, or upgrade mechanics. The `forge.upgrade` CLI command remains available for manual sync. This is not a dual-path: it is a single upgrade mechanism (`runUpgrade`) with two entry points (CLI and `forge-bootstrap`).

## Core behavioral layer (RFC-0548)

`forge.agents.generate` now includes a **Core behavioral layer** section in generated `AGENTS.md` files. This section is wrapped in `<!-- forge:begin behavioral-layer -->` / `<!-- forge:end behavioral-layer -->` markers and contains:

- **Intent-to-skill routing table** — generated from `triggers` fields in fo-skill frontmatter. Each row maps natural-language trigger phrases to the corresponding skill.
- **Fixed policy text** for 20 core behavioral areas: auto-grilling, auto-session-save, auto-review, context awareness, creator-facing communication, adaptive learning, proactive guidance, live operator feedback, register parameter, pushback policy, external capabilities (MCP), safety net, invisible quality, first creation moment, creative health, sharing and feedback, cultural awareness, indirect teaching, ownership, and commit policy (RFC-0551).
- **Conditional extended behavioral layer** (RFC-0549) — included only when the register is `creative` (read from `PREFERENCES.md` `register` field). Contains ten sections: personal connection, creative memory, emotional rhythm (questions not declarations), gentle accountability, creative partnership, visual thinking, audience empathy, creative companion (companion mode, `saveCompanionSessions` flag, pull-only inspiration feed), creative confidence (outcome-based praise, never refuse creative direction), and always-next-step (RFC-0551, supersedes the "at most one per session" anticipatory suggestion limit). Content is built by `src/onboarding/extended-behavioral-layer.ts`.

`forge.create` auto-runs `forge.agents.generate` after `forge.init`, so newly created projects get the behavioral layer from day one. If generation fails, a warning is logged but the create command continues.

The `triggers` field in skill frontmatter is validated by SKILL-16: optional array of 1-5 natural-language strings (each 5-100 characters), only allowed on fo-category skills. Pack skills may not declare triggers.

## Extended behavioral layer (RFC-0549)

The extended behavioral layer is conditionally included in generated `AGENTS.md` files when the operator's register is `creative`. It adds ten behavioral policies additive to the core layer:

1. **Personal connection** — operator name at key moments, project story, deep purpose as compass.
2. **Creative memory** — unimplemented ideas, aesthetic preferences, creative influences.
3. **Emotional rhythm** — session mood via questions (not declarations), return after break, progress celebration.
4. **Gentle accountability** — unfinished intentions, deep purpose checks.
5. **Creative partnership** — sounding board (2-3 alternatives), creative constraints, anticipatory suggestions.
6. **Visual thinking** — visual previews, visual diffs, milestone gallery, voice consistency, tone matching.
7. **Audience empathy** — audience perspective, first-visitor test, emotional memory, project narrative.
8. **Creative companion** — companion mode (`saveCompanionSessions` flag), creative blocks, inspiration feed (pull-only MVP, `inspirationFeed: on|off`).
9. **Creative confidence** — outcome-based praise (not effort-based), gentle purpose-drift pushback (never refuse creative direction).
10. **Always-next-step** (RFC-0551) — the agent MUST always propose a concrete next step after any pause point. Supersedes the "at most one anticipatory suggestion per session" limit from Creative partnership (section 5).

Three surrogate-relationship mitigations: questions instead of declarations, outcome-based praise, and 90-day entry expiry for emotional observations in `operator-profile.md`.

`fo-session-retro` routes extended-layer insights to `operator-profile.md` with Zugangsstufen tags: emotional rhythm → `[Vertraulich]` with 90-day expiry, aesthetic preferences → `[Öffentlich]`.

## Spec vendoring (RFC-0394..0397)

External specification packages are vendored as immutable snapshots under `docs/specs/<spec-id>/` with an integrity manifest and `forge-spec.yaml` projection.

- `forgeSpecModule` (in `os/spec/`) registers `spec.validate`, `spec.status`, `spec.materialize`.
- `spec.validate` enforces SPEC-01..07: integrity, schema, cycles, references, waves, duplicates, materializedAs.
- `spec.materialize` scaffolds RFC files for front nodes with `specRef` traceability and writes `materializedAs` back to `forge-spec.yaml`.
- `spec.status` projects per-node states, blockers, and progress.
- Spec amendments (`docs/specs/<id>/amendments/amd-NNN-*.md`) are the only correction channel — snapshot files are never modified.
