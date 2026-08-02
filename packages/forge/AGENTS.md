# @warpgogol/forge Agent Guide

Portable governance skills and command modules extracted from site-kernel (RFC-0374).

## Architecture

- `src/` — portable, no kernel imports. Contains skill schema, registry, validators, onboarding handlers, config module, canonical types, and utilities.
- `os/` — ForgeModule registrations. RFC-0556: `os/compass/` and `os/werkstatt/` are fully autonomous — all command handlers are inlined in `os/*/handlers/` and no longer dynamically import `@warpgogol/*` packages. Other `os/` modules may still use dynamic imports where kernel integration is needed.
- `bin/` — CLI entrypoint (`forge` command) for autonomous usage without `@warpgogol/site-kernel`.
- `skills/` — forge-managed skill definitions (26 fo skills + 4 shared + 3 meta = 33 skills). Project-declared skill packs (RFC-0539) live outside forge and are discovered via `discoverPackSkills` from `forge.yaml` `skillPacks` config.

## OS modules

| Module | Commands | Source |
| --- | --- | --- |
| `forgeCoreModule` | `forge.create`, `forge.doctor`, `forge.upgrade`, `forge.agents.generate`, `forge.scaffold`, `forge.port.scaffold`, `forge.skill.validate`, `forge.skill.list`, `forge.port.validate`, `forge.profile.validate`, `docs.archive` | `os/core/` |
| `forgeRfcModule` | `rfc.list`, `rfc.validate`, `rfc.create`, etc. | `os/rfc/` |
| `forgeWorkflowModule` | `workflow.lint`, `workflow.list`, `workflow.amend.list` | `os/workflow/` |
| `forgeNamingModule` | `naming.convention.lint` | `os/naming/` |
| `forgeCompassModule` | `compass.inventory`, `compass.validate`, `compass.summary.trim`, etc. (8 commands). All compass commands accept `--workpiece <path>` for scoping to a mission workpiece directory (RFC-0617). | `os/compass/` |
| `forgeWerkstattModule` | `werkstatt.lock.status`, `werkstatt.lock.recover`, `werkstatt.operation.validate` | `os/werkstatt/` |
| `forgeSpecModule` | `spec.validate`, `spec.status`, `spec.materialize` | `os/spec/` |
| `forgeAdrModule` | `adr.list`, `adr.create`, `adr.validate`, `adr.archive` | `os/adr/` |
| `forgePlanModule` | `plan.archive` | `os/plan/` |
| `forgeAuditModule` | `audit.archive` | `os/audit/` |
| `forgeSessionModule` | `session.save`, `session.archive`, `session.validate`, `session.list` | `os/session/` |
| `forgeMissionModule` | `mission.archive` | `os/mission/` |

## Archive convention

When archiving terminal artifacts, prefer the `docs.archive` umbrella command over individual `rfc.archive`, `adr.archive`, `plan.archive`, `audit.archive`, `session.archive`, `mission.archive` commands. The umbrella command runs all six in sequence and prevents leaving audits/plans/sessions/missions unarchived when the operator's intent is to clean up all terminal artifacts. Use individual commands only when the operator explicitly asks for a single domain (e.g. "archive only RFCs").

## Skills

Skills live in `skills/` and are synced to `.agents/skills/` by `forge.create`. Each skill has a `SKILL.md` with standardized frontmatter (name, description, category, concerns, dependsOn).

- **When editing a skill in `packages/forge/skills/`**, the synced copy in `.agents/skills/` MUST also be committed in the same session — `forge.create` is not run automatically after manual edits. Stale `.agents/skills/` copies cause `forge.doctor` to report drift.

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
- `os/compass/` and `os/werkstatt/` are fully autonomous (RFC-0556) — all handlers are inlined in `os/*/handlers/` and must NOT import from `@warpgogol/*` packages.
- Other `os/` modules MAY dynamically import `@warpgogol/*` packages where kernel integration is needed.
- Apps import forge modules from `@warpgogol/forge` (the package entrypoint re-exports all OS modules).
- **MUST** use `hasGeneratedMarker()` from `utils/index.ts` for detecting generated file markers — never use raw `content.includes("GENERATED")` which is fragile and breaks if the marker format changes.
- **Compass shared flags:** New flags for compass commands MUST be added to the shared `compassScanFlags` object in `os/compass/compass.module.ts`, not to individual command definitions. The `compassScanFlags` object is spread into all compass commands that use `flags: { ...compassScanFlags }`, ensuring the flag is available consistently across the command family. Per-command flags that are unique to one command may be defined inline.

## RFC frontmatter: commands.changed (RFC-CMD-03)

The `commands.changed` field in RFC frontmatter must only list **registered CLI commands** (e.g. `compass.audit.baseline`, `mission.materialize`), not internal functions or handlers (e.g. `acquireLock`, `releaseLock`). `rfc.validate` enforces this via RFC-CMD-03: every entry in `commands.changed` must match a live command in the registry. Internal functions that are not registered as CLI commands must not appear in `commands.changed` — use `packagesImpacted` to indicate which packages were modified.

## RFC frontmatter: YAML backtick quoting

YAML plain scalar values that **start with a backtick** (`` ` ``) must be double-quoted. Backtick is a reserved character in YAML plain scalars — the parser fails with "Plain value cannot start with reserved character `" and `rfc.implement.stamp`reports "Could not parse target RFC" (RFC-IMP-01). This commonly affects`successSignals`, `nonGoals`, and other list items in RFC frontmatter that reference code identifiers in backticks. Always quote such strings: `` - "`forge.doctor`reports domain information" `` instead of `` -`forge.doctor` reports domain information ``.

## RFC command lifecycle validation (RFC-CMD-02)

`getLiveCommands` in `os/rfc/handlers/lifecycle.ts` always merges `commandRegistry.listCommands()` with `docs/command-manifest.generated.yaml`. This is necessary because lazy-loaded modules (e.g. `leitstand`) are not loaded when `rfc.validate` runs, so their commands are absent from the registry but present in the manifest. Never change this to a fallback-only pattern (using manifest only when registry is empty) — that produces false-positive `RFC-CMD-02` violations for commands from lazy-loaded modules.

## Re-entrant werkstatt locks (RFC-0616)

`acquireLock` and `releaseLock` in `os/werkstatt/handlers/lock.ts` are re-entrant by PID. When the same process re-acquires a lock it already holds, `acquireLock` increments the `depth` counter instead of throwing. `releaseLock` decrements `depth` and only deletes the lock file when `depth` reaches `1` or is `undefined`. The `depth` field is `.optional()` in `werkstattLockSchema` — old lock files without `depth` parse successfully and are treated as `depth=1` via `?? 1` fallbacks. Agents MUST NOT assume `acquireLock` always throws on an existing lock file — it only throws when a **different** live process holds the lock.

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

### Domain fields (RFC-0638)

The `forge/stack-profile@1` schema includes six optional domain-neutral fields that allow a profile to declare its domain model. All fields are optional — existing profiles without them parse and function identically.

- **`domain`** — string identifying the project domain (e.g. `software`, `video`, `book`, `music`, `game`, `illustration`). Used for profile detection and doctor output.
- **`terminology`** — map of universal concept keys to domain-specific terms (e.g. `artifact: "composition"`). Open vocabulary; universal keys have built-in defaults exported as `TERMINOLOGY_DEFAULTS`. Missing keys fall back to the default term.
- **`artifacts`** — array of artifact definitions (id, extensions, produce/validate commands, determinism properties). Used by `forge.doctor` for domain-specific health checks in follow-up RFCs.
- **`workspaceTypes`** — array of workspace type definitions (id, detection markers, associated skills, AGENTS.md template). Used by `forge.agents.generate` for per-domain workspace detection in follow-up RFCs.
- **`invariants`** — array of domain-specific invariant definitions (id matching `^[A-Z]+-\d+$`, rule text, severity). Schema only — enforcement is deferred to follow-up RFCs.
- **`register`** — string selecting the default behavioral register (`business` or `creative`). Used by `forge.create` as a one-time default for new projects; existing `PREFERENCES.md` is never overwritten.

Types and schemas are exported from `@warpgogol/forge`: `StackProfileDomainFields`, `ProfileArtifact`, `ProfileWorkspaceType`, `ProfileInvariant`, `stackProfileDomainFieldsSchema`, `UNIVERSAL_TERMINOLOGY_KEYS`, `TERMINOLOGY_DEFAULTS`.

### Domain-aware commands (RFC-0640)

The following commands are domain-aware — they read domain fields from the stack profile and `forge.yaml` to adapt their behavior:

- **`forge.profile.validate`** — validates profile YAML files under `packages/forge/profiles/` against the `forge/stack-profile@1` schema (including RFC-0638 domain fields). Supports `--id <profile-id>` to validate a single profile. Returns exit 1 if any profile is invalid.
- **`forge.create`** — reads `domain`, `terminology`, `register`, and artifact-derived semantic bindings from the selected profile and writes them into `forge.yaml` (domain, terminology, bindings.commands) and `PREFERENCES.md` (register). When the profile has no domain fields, behavior is unchanged (software-domain fallback).
- **`forge.doctor`** — reports domain info (domain, source, register, terminology, invariant count) as a `domain-info` check. Lists declared invariants as a `domain-invariants` check (reported-only, advisory). Runs `forge.profile.validate` as an advisory `profile-validate` check (warn status on failure, not gating — shipped profiles are forge-internal). Skips software-specific checks (nested AGENTS.md) for non-software domains. The `--strict` flag is declared in the command registration but does not affect invariant reporting — it is reserved for future use when automatic checking is added. Domain is resolved via a three-tier chain: `forge.yaml` `project.domain` → stack profile `domain` → default `software`.
- **`forge.agents.generate`** — loads `workspaceTypes[]` from the matching stack profile and passes them to `discoverWorkspaces` for profile-driven workspace type detection. When the profile has no `workspaceTypes`, falls back to hardcoded detection (astro.config → app, Dockerfile → service, else package).

## Bindings contract (RFC-0393)

The `bindings` section in `forge.yaml` de-hardcodes project-specific values from fo-skills. Skills reference bindings by key (e.g. `ref(forge.yaml bindings.commands.validateRfc)`) instead of hardcoding commands, paths, or terminology.

- `forgeBindingsSchema` + `resolveBinding(config, key, placeholders?)` are exported from `@warpgogol/forge`.
- `forge.doctor` validates bindings: checks path existence, reports resolved/absent/invalid, and emits `defaultable-binding-null` notices for forge-CLI-backed bindings that are null (RFC-0540).
- `forge.create` writes forge-CLI-backed defaults for commands forge provides (`validateRfc`, `validateAdr`, `implementStamp`, `specValidate`) and null for stack-dependent commands (`typecheck`, `test`, `scopedBuild`). The package manager from `forge.yaml` determines the runner prefix (`pnpm exec`, `npx`, `yarn exec`, `bunx`).
- `forge.skill.validate` enforces SKILL-11: canonical skill bodies must not contain hardcoded `pnpm exec site-kernel run` or `docs/architecture-dna.md` in instruction lines (code blocks and `run:` directives). Supports `<!-- skill-lint-disable SKILL-11 -->` escape hatch.
- `forge.skill.validate` enforces SKILL-17: skill files must not contain specific platform RFC/ADR ids (`RFC-\d{4}`, `ADR-\d{4}`) or platform names ("Warpgogol", "Warpgogol", "WarpGogol"). Generic "RFC"/"ADR" terms, generic placeholder ids (`RFC-XXXX`), file paths (`adr-0000-template.md`), and binding key names (`validateRfc`) are allowed. The `@warpgogol/forge` npm package name is excluded from the platform name check. Supports `<!-- skill-lint-disable SKILL-17 -->` escape hatch.
- Skills declare binding requirements in frontmatter: `bindings: { requires: [...], optional: [...] }`.
- Degradation contract: required binding unresolvable → skill refuses to start; optional binding absent → step skipped with `Degraded:` line in report.
- **RFC-0609: Binding templates must use flag format.** CLI binding templates in `FORGE_CLI_BINDING_DEFAULTS` and `forge.yaml` must use `--id {id}` (flag format), not `{id}` (positional). For example: `forge rfc.validate --id {id} --json`, not `forge rfc.validate {id} --json`. This applies to `validateRfc`, `validateAdr`, and any future binding that passes an identifier to a command.

### Semantic command keys (RFC-0639)

The `forge/bindings@1` schema includes five optional semantic command keys that work across all domains. These coexist with the software-specific keys (`typecheck`, `test`, `scopedBuild`) — they do not replace them.

- **`commands.validate`** — domain-neutral validation command (replaces `typecheck` for non-software domains).
- **`commands.produce`** — domain-neutral artifact production command (replaces `scopedBuild`).
- **`commands.verify`** — domain-neutral verification command (replaces `test`).
- **`commands.preview`** — domain-neutral preview command (e.g. dev server, live preview).
- **`commands.lint`** — domain-neutral linting command.

All semantic keys are optional with `null` defaults. `applyCliBindingDefaults` initializes them with `null` (they are stack-dependent, not CLI-backed). `forge.doctor` does **not** validate semantic keys — they are opt-in per-domain, so reporting them as `absent` for projects that intentionally leave them `null` would be noise. Skills reference them via `ref(bindings.commands.produce)` etc.

### Terminology resolution (RFC-0639)

The `terminology` field in `forge/bindings@1` is non-optional with a `{}` default (changed from `.optional()` in RFC-0639). `resolveTerminology(config, terminology, key)` resolves a terminology key using a three-tier chain:

1. **Tier 1 — bindings override**: `config.bindings.terminology[key]` (per-project).
2. **Tier 2 — caller-provided**: the `terminology` parameter (typically `profile.terminology` from RFC-0638).
3. **Tier 3 — universal default**: `TERMINOLOGY_DEFAULTS` from `@warpgogol/forge` (re-exported from `profile-schema.ts`).

If the key is not found in any tier, the key itself is returned. The `terminology` parameter is `Record<string, string> | undefined` — a separate parameter, not embedded in `StackProfile` — so the function works whether or not RFC-0638 profile terminology is available.

`resolveTerminology` is exported from `@warpgogol/forge` and `@warpgogol/forge/config`.

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

The `forge-bootstrap` skill step 0 silently checks `forge.syncedVersion` against the installed `@warpgogol/forge` version. If they differ, it runs `forge upgrade` invisibly — the operator is never informed about migration, version numbers, or upgrade mechanics. The `forge.upgrade` CLI command remains available for manual sync. This is not a dual-path: it is a single upgrade mechanism (`runUpgrade`) with two entry points (CLI and `forge-bootstrap`).

## Core behavioral layer (RFC-0548)

`forge.agents.generate` now includes a **Core behavioral layer** section in generated `AGENTS.md` files. This section is wrapped in `<!-- forge:begin behavioral-layer -->` / `<!-- forge:end behavioral-layer -->` markers and contains:

- **Intent-to-skill routing table** — generated from `triggers` fields in fo-skill frontmatter. Each row maps natural-language trigger phrases to the corresponding skill.
- **Fixed policy text** for 20 core behavioral areas: auto-grilling, auto-session-save, auto-review, context awareness, creator-facing communication, adaptive learning, proactive guidance, live operator feedback, register parameter, pushback policy, external capabilities (MCP), safety net, invisible quality, first creation moment, creative health, sharing and feedback, cultural awareness, indirect teaching, ownership, and commit policy (RFC-0551).
- **Conditional extended behavioral layer** (RFC-0549) — included only when the register is `creative` (read from `PREFERENCES.md` `register` field). Contains ten sections: personal connection, creative memory, emotional rhythm (questions not declarations), gentle accountability, creative partnership, visual thinking, audience empathy, creative companion (companion mode, `saveCompanionSessions` flag, pull-only inspiration feed), creative confidence (outcome-based praise, never refuse creative direction), and always-next-step (RFC-0551, supersedes the "at most one per session" anticipatory suggestion limit). Content is built by `src/onboarding/extended-behavioral-layer.ts`.

`forge.create` auto-runs `forge.agents.generate` after `forge.init`, so newly created projects get the behavioral layer from day one. If generation fails, a warning is logged but the create command continues.

The `triggers` field in skill frontmatter is validated by SKILL-16: optional array of 1-5 natural-language strings (each 5-100 characters), only allowed on fo-category skills. Pack skills may not declare triggers.

## Nested AGENTS.md generation (RFC-0611)

`forge.agents.generate` also generates nested `AGENTS.md` files for workspace directories (directories containing `package.json`). Workspace type is auto-detected by content markers:

- **app** — directory with `astro.config.*`
- **service** — directory with `Dockerfile` or `service.config.yaml`
- **package** — directory with `package.json` only
- Precedence: app > service > package

Workspace-type detection rules are defined in RFC-0611. Agents MUST NOT add new detection rules without an amending RFC.

The edit guard skips hand-written nested `AGENTS.md` files (no generated marker) and reports them in the `skipped` array. Generated files (with marker) are regenerated if content differs. `forge.upgrade` also runs nested generation after skill sync. `forge.doctor` checks for missing, stale (in-memory comparison), and hand-written improvement opportunities.

`forge.agents.generate` supports `dryRun` mode (RFC-0601 pattern): it renders content in memory without writing to disk, returning `renderedFiles` in the result. This is used by `forge.doctor` for staleness detection.

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

## RFC commands frontmatter (RFC-CMD-01..03)

When an RFC transitions to `implemented`, `rfc.validate` enforces command lifecycle rules against the `commands:` frontmatter:

- **RFC-CMD-01:** A live command listed under `commands.proposed` but not `commands.added` is a violation. For implemented RFCs, newly created commands MUST be in `commands.added`, not `commands.proposed`. `commands.proposed` is only valid for RFCs in `draft` or `accepted` status.
- **RFC-CMD-03:** Every entry under `commands.changed` MUST be a registered live command (present in `docs/command-manifest.generated.yaml`). Pipeline names (e.g. `build.prepare`, `SITES_BUILD_PREPARE_PIPELINE`) are NOT registered commands — they MUST NOT be listed under `commands.changed`. If an RFC modifies a pipeline array, that is not a command registration change.

## Spec vendoring (RFC-0394..0397)

External specification packages are vendored as immutable snapshots under `docs/specs/<spec-id>/` with an integrity manifest and `forge-spec.yaml` projection.

- `forgeSpecModule` (in `os/spec/`) registers `spec.validate`, `spec.status`, `spec.materialize`.
- `spec.validate` enforces SPEC-01..07: integrity, schema, cycles, references, waves, duplicates, materializedAs.
- `spec.materialize` scaffolds RFC files for front nodes with `specRef` traceability and writes `materializedAs` back to `forge-spec.yaml`.
- `spec.status` projects per-node states, blockers, and progress.
- Spec amendments (`docs/specs/<id>/amendments/amd-NNN-*.md`) are the only correction channel — snapshot files are never modified.

## NPM publish workflow

To publish a new version of `@warpgogol/forge` to NPM:

1. Bump `version` in `packages/forge/package.json` (semver: minor for new skills/features, patch for fixes).
2. Bump `forge.syncedVersion` in `forge.yaml` to match.
3. Run `pnpm --filter @warpgogol/forge run build` — compiles TypeScript to `dist/`.
4. Run `node packages/forge/scripts/publish-check.mjs` — verifies metadata, dist/ freshness, README, VERSION sourcing, and files array.
5. Run `npm publish --access public` from `packages/forge/` — publishes to `@warpgogol/forge` on npmjs.org.
6. Commit version bumps: `git add packages/forge/package.json forge.yaml && git commit -m "release: @warpgogol/forge@<version>"`.

The `prepublishOnly` script runs `clean → build → publish-check` automatically, so steps 3-4 are redundant if publishing via `npm publish` directly.

## Git command patterns in forge handlers

- **`git log --oneline` output includes a hash prefix** — the format is `<hash> <message>`, not `<message>`. When matching commit message patterns in `--oneline` output, do NOT anchor the regex to `^implement:` or `^feat:` — the line starts with the hash. Use a non-anchored pattern like `implement:\s+RFC-\d{4}\b` instead. Discovered during RFC-0625 V-32 implementation where `^implement:` failed to match `--oneline` output.
- **`execGit` helper pattern** — multiple forge handlers (`implement-stamp.ts`, `verification-evidence.ts`, `validate-rules.ts`, `validate.ts`) each define their own `execGit`/`execGitLog` helper wrapping `execFile("git", ...)`. These are candidates for extraction into a shared `os/utils/git.ts` utility.
