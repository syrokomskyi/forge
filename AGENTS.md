# @warpgogol/forge Agent Guide

Portable governance skills and command modules extracted from site-kernel (RFC-0374).

## Architecture

- `src/` — portable, no kernel imports. Contains skill schema, registry, validators, onboarding handlers, config module, canonical types, and utilities.
- `os/` — ForgeModule registrations. RFC-0556: `os/compass/` and `os/werkstatt/` are fully autonomous — all command handlers are inlined in `os/*/handlers/` and no longer dynamically import `@warpgogol/*` packages. Other `os/` modules may still use dynamic imports where kernel integration is needed.
- `bin/` — CLI entrypoint (`forge` command) for autonomous usage without `@warpgogol/site-kernel`.
- `skills/` — forge-managed skill definitions (38 fo skills + 5 shared + 3 meta = 46 skills). Project-declared skill packs (RFC-0539) live outside forge and are discovered via `discoverPackSkills` from `forge.yaml` `skillPacks` config.

## OS modules

| Module | Commands | Source |
| --- | --- | --- |
| `forgeCoreModule` | `create`, `doctor`, `upgrade`, `forge.agents.generate`, `scaffold`, `port.scaffold`, `skill.validate`, `skill.list`, `port.validate`, `profile.validate`, `dev`, `build`, `validate`, `pinned.validate`, `pinned.init`, `docs.archive` | `os/core/` |
| `forgeRfcModule` | `rfc.list`, `rfc.validate`, `rfc.create`, etc. | `os/rfc/` |
| `forgeWorkflowModule` | `workflow.lint`, `workflow.list`, `workflow.amend.list` | `os/workflow/` |
| `forgeNamingModule` | `naming.convention.lint` | `os/naming/` |
| `forgeCompassModule` | `compass.inventory`, `compass.validate`, `compass.summary.trim`, etc. (8 commands). All compass commands accept `--workpiece <path>` for scoping to a mission workpiece directory (RFC-0617). | `os/compass/` |
| `forgeWerkstattModule` | `werkstatt.lock.status`, `werkstatt.lock.recover`, `werkstatt.operation.validate` | `os/werkstatt/` |
| `forgeSpecModule` | `spec.validate`, `spec.status`, `spec.materialize`, `spec.live.merge`, `spec.live.list`, `spec.live.show`, `spec.live.validate` | `os/spec/` |
| `forgeAdrModule` | `adr.list`, `adr.create`, `adr.validate`, `adr.archive`, `adr.implement.stamp` | `os/adr/` |
| `forgePlanModule` | `plan.archive` | `os/plan/` |
| `forgeAuditModule` | `audit.archive` | `os/audit/` |
| `forgeSessionModule` | `session.save`, `session.archive`, `session.validate`, `session.list` | `os/session/` |
| `forgeMissionModule` | `mission.archive` | `os/mission/` |
| `forgeExplorationModule` | `exploration.list`, `exploration.show`, `exploration.archive` | `os/exploration/` |

## Archive convention

When archiving terminal artifacts, prefer the `docs.archive` umbrella command over individual `rfc.archive`, `adr.archive`, `plan.archive`, `audit.archive`, `session.archive`, `mission.archive` commands. The umbrella command runs all six in sequence and prevents leaving audits/plans/sessions/missions unarchived when the operator's intent is to clean up all terminal artifacts. Use individual commands only when the operator explicitly asks for a single domain (e.g. "archive only RFCs").

- **RFC-0711: `docs.archive` post-loop `spec.live.merge` step.** After archiving, `docs.archive` scans implemented RFCs with a `liveSpec` frontmatter field and calls `spec.live.merge` for each, creating or updating living feature specs under `docs/specs/live/<domain>.md`. Rejected RFCs with `liveSpec` are skipped. Merge failures are non-fatal — the archive step still completes. Use `--dry-run` to preview merges without writing.

- **Post-rename cleanup for `fs.rename` on watched directories:** When an archive handler uses `fs.rename` to move a directory that an IDE or file watcher is tracking (e.g. mission workpiece with an open `.astro/` cache), the watcher may recreate stale cache at the source path after the rename completes. Always add a post-rename cleanup check using `trashPath` from `utils/fs-trash.ts`: `if (existsSync(sourcePath)) { await trashPath(sourcePath); }` after the `fs.rename` call. See `os/mission/handlers/archive.ts` `moveMissionDir` for the reference implementation.

## Pinned-files protection (RFC-0733)

The pinned-files protection system prevents accidental deletion, move, or modification of foundational files (templates, configs, structural directories). It is opt-in — protection is active only when `.forge/pinned.yaml` exists.

- **`forge pinned.init`** creates `.forge/pinned.yaml` with default foundation entries, installs a pre-commit hook, adds `.forge/pinned-audit.log` to `.gitignore`, and optionally generates a CI workflow (`--ci`). Re-running merges defaults with existing entries — operator-removed default entries are re-added, but custom entries are never overwritten or removed.
- **`forge pinned.validate`** checks the working tree against the manifest. In `staged` mode (default), it checks `git diff --cached`; in `ci` mode (`--mode ci`), it checks the last-commit diff. Violations for `delete` and `move` operations are always blocked; `modify` is blocked only for `freeze` mode entries (not `protect`).
- **Override:** Use `--allow-pinned-override <path>` for an audited escape hatch. Each override is logged to `.forge/pinned-audit.log` (append-only, gitignored) with timestamp, path, mode, and reason. The `FORGE_PINNED_OVERRIDE` env var (comma-separated paths) is also read by `pinned.validate` — this allows the pre-commit hook to support overrides without changing the hook script: `FORGE_PINNED_OVERRIDE=docs/rfcs/rfc-0076.md git commit`.
- **Manifest integrity:** `pinned.validate` compares the current manifest against the last-committed version. If entries have been removed, it reports `PINNED_MANIFEST_TAMPERED`.
- **Archive pre-check:** All 6 archive handlers (`rfc.archive`, `adr.archive`, `plan.archive`, `audit.archive`, `session.archive`, `mission.archive`) load the pinned manifest once per invocation and skip pinned files/directories with a warning instead of moving them. When the manifest is missing, archive handlers behave as before (protection inactive). **Intra-directory moves are exempted:** if both source and destination are within the same pinned directory (e.g. `docs/rfcs/rfc-0076.md` → `docs/rfcs/archive/implemented/rfc-0076.md`), the move is allowed — the file hasn't left the protected directory.
- **`.forge/` directory:** The `.forge/` directory is a forge-specific convention for project-local governance files. It sits alongside `forge.yaml` and contains `pinned.yaml` (manifest) and `pinned-audit.log` (override audit trail).

## Skills

Skills live in `skills/` and are synced to `.agents/skills/` by `create`. Each skill has a `SKILL.md` with standardized frontmatter (name, description, category, concerns, dependsOn).

- **When editing a skill in `packages/forge/skills/`**, the synced copy in `.agents/skills/<name>/SKILL.md` MUST also be committed in the same session — `create` is not run automatically after manual edits. Stale `.agents/skills/` copies cause `doctor` to report drift.
- **Canonical sync path is flat**: `.agents/skills/<name>/SKILL.md` (e.g. `.agents/skills/fo-idea-implement/SKILL.md`). Both `create` (`init.ts`) and `upgrade` (`upgrade.ts`) sync to this flat path. A nested `.agents/skills/fo/<name>/SKILL.md` path is NOT created or maintained by forge — it is a stale artifact if present and should be removed.
- **`FORGE_SKILLS[].path` is relative to the forge package root** and already includes the `skills/` prefix — resolve via `path.join(forgeRoot, skill.path)` (see `init.ts`). Never join a `skillsRoot` with `skill.path`: that produces a doubled `skills/skills/` prefix and silently finds nothing.

The `concerns` field uses a four-level taxonomy (RFC-0523): `read-only` (no file modifications), `document-only` (modifies `.md` files only), `content-mutation` (modifies content `.md`/`.yaml` but not executable code), `code-mutation` (modifies `.ts`/`.astro` code). `skill.validate` enforces this via SKILL-12.

The optional `knowledge` field (RFC-0524) declares cumulative knowledge files as an array of file names relative to the SKILL.md directory (e.g. `knowledge: [qa-log.md, learned-principles.md]`). `skill.validate` enforces SKILL-13: declared knowledge files must exist. `create` syncs them to `.agents/skills/`. `doctor` detects stale copies. See `writing-great-skills` § Cumulative knowledge pattern for the three-layer reference pattern, entry format, and mutation contract. RFC-0660 adds SKILL-19 (entry schema validity) and SKILL-20 (identifier uniqueness) for structured knowledge entries, and `doctor` reports legacy-section counts. RFC-0661 adds SKILL-21 (hot/warm layer character budget warnings — warnings only, never build gates) and `doctor` reports budget summaries with headroom %.

### Validator return-type refactoring

When refactoring a validator's return type (e.g. from `Violation[]` to `{ errors, warnings }`), update **all** return points and call sites in the same commit. TypeScript catches missing fields in return objects, but does not catch semantic errors like warnings accidentally left in the violations array. After refactoring, search for all `return` statements and all call sites that destructure the result, and verify each one handles both `errors` and `warnings` correctly.

### Skill packs (RFC-0539)

Project-declared skill packs allow projects to manage their own skills under a project-specific prefix, separate from forge's portable `fo-` skills. Packs are declared in `forge.yaml` under `skillPacks`:

```yaml
skillPacks:
  - prefix: wg
    dir: packages/warpgogol-skills/skills
```

- `create` syncs pack skills alongside forge skills into `.agents/skills/`.
- `skill.validate` validates pack skills with SKILL-01..13 plus SKILL-14 (pack skill name must start with pack prefix), SKILL-15 (non-forge skill may not use `fo-` prefix), and SKILL-17 (no platform RFC/ADR ids or platform names).
- SKILL-07 enforces asymmetric dependency direction: pack skills may depend on forge skills, but forge skills may not depend on pack skills (breaks portability).
- `skill.list` includes pack skills with `pack:<prefix>` annotation.
- `doctor` checks for stale/missing pack skill copies and validates `skillPacks` config (unique prefixes, unique dirs, no `fo` prefix, dir exists).
- **RFC-0552:** `create` (via `runInit`) and `upgrade` (via `syncPackSkills`) detect pack skills whose name conflicts with a Forge skill name. Conflicting pack skills are skipped (not copied to `.agents/skills/`) and reported in `skippedSkills` on `InitResult` and `UpgradeResult`. The `forge-bootstrap` skill reports skipped skills to the operator during onboarding. The `forge-bootstrap` skill also runs `git init` for greenfield projects without a `.git` directory and commits synced skills to git.

## Import rules

- `src/` must NOT import from `@warpgogol/site-kernel` or any kernel package.
- `os/compass/` and `os/werkstatt/` are fully autonomous (RFC-0556) — all handlers are inlined in `os/*/handlers/` and must NOT import from `@warpgogol/*` packages.
- Other `os/` modules MAY dynamically import `@warpgogol/*` packages where kernel integration is needed.
- Apps import forge modules from `@warpgogol/forge` (the package entrypoint re-exports all OS modules).
- **MUST** use `hasGeneratedMarker()` from `utils/index.ts` for detecting generated file markers — never use raw `content.includes("GENERATED")` which is fragile and breaks if the marker format changes.
- **Compass shared flags:** New flags for compass commands MUST be added to the shared `compassScanFlags` object in `os/compass/compass.module.ts`, not to individual command definitions. The `compassScanFlags` object is spread into all compass commands that use `flags: { ...compassScanFlags }`, ensuring the flag is available consistently across the command family. Per-command flags that are unique to one command may be defined inline.
- **CLI flags must be wired to behavior.** Every flag declared in a command registration MUST affect the command's output or behavior — not just be read and stored. A flag that is read but never used is dead code and a contract violation. When adding a flag, implement its behavioral effect in the same commit. Verify by searching for the flag variable name in the handler function body.
- **Profile-driven workspace detection is domain-neutral.** `workspaceTypes` from a stack profile must replace hardcoded workspace detection for ALL domains, not just software. Do NOT gate `checkNestedAgentsMd` or `discoverWorkspaces` by `isSoftwareDomain` — that silently skips the check for non-software domains (video, creative, etc.). When `workspaceTypes` is present, it fully replaces hardcoded detection; when absent, hardcoded detection is the fallback for all domains.
- **`command-registered` probes MUST fall back to command manifest.** The `command-registered` probe in `os/rfc/acceptance.ts` uses `commandRegistry?.listCommands()`, which only sees workspace-scoped commands (forge modules). App-scoped commands from `site-kernel-checks` are invisible to the workspace-level registry. Always include a `loadManifestCommandNames(workspaceRoot)` fallback, matching the pattern already used in `os/rfc/handlers/lifecycle.ts`. Without this, `rfc.acceptance.run` and `rfc.verification.emit` will falsely report app-scoped commands as "not registered".

## Editframe template rules

- **TimelineRoot MUST NOT be used inside Workbench.** `TimelineRoot` renders a `<div style="display: contents">` wrapper that breaks `EFWorkbenchElement.#initialize()` — it searches for `TemporalElement` among direct children of `ef-canvas`, but the div wrapper makes `ef-timegroup` a grandchild instead of a direct child. The correct structure is `Workbench > Configuration > Timegroup`. `TimelineRoot` is only valid outside `Workbench` (e.g. standalone render compositions without preview).
- **Text content MUST be passed as children, not via `text` prop.** `ef-text` reads text from child text nodes via `#captureRawText()`, not from the `text` attribute. Use `<Text style={{ color: "white" }}>Hello</Text>`, not `<Text text="Hello" color="white" />`.
- **Text styling MUST use the `style` prop or CSS classes, not HTML attributes.** `ef-text` does not read `x`, `y`, `fontSize`, `color`, `textAlign` as attributes. Pass them via `style={{ fontSize: "48px", color: "white" }}` or Tailwind classes.
- **Timegroup inside Workbench MUST have explicit dimensions.** Without `style={{ width, height }}`, `Timegroup` renders as a 0×0 inline element. Set dimensions matching the composition resolution (e.g. `1920px` × `1080px`).
- **main.tsx MUST set `height: 100%` on `html`, `body`, and `#root`** and override `ef-workbench { display: grid }` after importing `@editframe/elements/styles.css`. The document-level `ef-workbench { display: block }` rule overrides the shadow DOM `:host { display: grid }`, breaking the grid layout and making the preview invisible.
- **In `contain` mode, parent duration = max child duration.** If a child `Text` has `duration="5s"` but the parent `Timegroup` has `duration="10s"`, the composition will be 5s, not 10s. Always match child durations to the parent when using `contain` mode, or the composition will be silently shorter than expected.
- **`--ef-progress` CSS variable (0→1) is available on temporal elements** for driving animations. Use it in `style` props: `opacity: "min(1, var(--ef-progress, 0) * 5)"` fades in over the first 20% of the timeline. `transform: "scale(min(1, 0.8 + var(--ef-progress, 0) * 0.2))"` scales from 0.8 to 1.0. The variable is set by the temporal clock and updates during playback and scrubbing.
- **`PlaybackController.play()` after `ended` does NOT seek to 0** — this is a race condition in `@editframe/elements`. To make replay work, patch `play()` in a `useEffect` via a `ref` on the `Workbench` element: query `ef-configuration`, access `.playback`, and wrap `play()` to call `play({ from: 0 })` when `currentTime >= duration`. Also listen for the `playback-attached` event for late-bound controllers.
- **`@editframe/react` TypeScript types do not expose `ref` or accept all CSS string values.** Use `as any` casts (`const EFWorkbench = Workbench as any`, etc.) to bypass type errors without changing runtime behavior. This is required for `ref` on `Workbench` and for CSS function values like `min()` and `var()` in `style` props.

## RFC frontmatter: commands.changed (RFC-CMD-03)

The `commands.changed` field in RFC frontmatter must only list **registered CLI commands** (e.g. `compass.audit.baseline`, `mission.materialize`), not internal functions or handlers (e.g. `acquireLock`, `releaseLock`). `rfc.validate` enforces this via RFC-CMD-03: every entry in `commands.changed` must match a live command in the registry. Internal functions that are not registered as CLI commands must not appear in `commands.changed` — use `packagesImpacted` to indicate which packages were modified.

## RFC frontmatter: YAML backtick quoting

YAML plain scalar values that **start with a backtick** (`` ` ``) must be double-quoted. Backtick is a reserved character in YAML plain scalars — the parser fails with "Plain value cannot start with reserved character `" and `rfc.implement.stamp`reports "Could not parse target RFC" (RFC-IMP-01). This commonly affects`successSignals`, `nonGoals`, and other list items in RFC frontmatter that reference code identifiers in backticks. Always quote such strings: `` - "`doctor`reports domain information" `` instead of `` -`doctor` reports domain information ``.

**Agent action:** After creating an RFC with `rfc.create`, scan the generated `successSignals` and `nonGoals` sections for unquoted backtick entries. Fix them immediately before committing. This prevents a recurring pattern where `ecosystem.manifest.generate` and `rfc.implement.stamp` fail on RFCs created with backtick-heavy frontmatter.

**Diagnostic:** If `rfc.implement.stamp` fails with `Could not parse target RFC` (RFC-IMP-01), the RFC frontmatter has a YAML syntax error — not a missing file. Check for unquoted backtick values first.

## RFC command lifecycle validation (RFC-CMD-02)

`getLiveCommands` in `os/rfc/handlers/lifecycle.ts` always merges `commandRegistry.listCommands()` with `docs/command-manifest.generated.yaml`. This is necessary because lazy-loaded modules (e.g. `leitstand`) are not loaded when `rfc.validate` runs, so their commands are absent from the registry but present in the manifest. Never change this to a fallback-only pattern (using manifest only when registry is empty) — that produces false-positive `RFC-CMD-02` violations for commands from lazy-loaded modules.

## RFC status transitions: rfc.implement.stamp is exclusive (V-16)

`rfc.implement.stamp` is the **exclusive atomic path** for accepted → implemented transitions. It atomically sets `status: implemented`, `implementedAt`, and `updatedAt` together. **NEVER** manually edit RFC frontmatter to set `implementedAt` or change `status` to `implemented` — this bypasses the atomic guarantee and risks leaving `status` and `implementedAt` out of sync. V-16 enforces this as an error: `status: accepted/draft` with `implementedAt` set, or `status: implemented` with empty `implementedAt`, both fail `rfc.validate`. After implementing an RFC, run `rfc.implement.stamp --id RFC-XXXX --implementation-commit <sha>` to stamp it.

## RFC acceptance criteria: evidence annotation (RFC-IMP-02)

`rfc.implement.stamp` enforces RFC-IMP-02: every checked acceptance criterion (`- [x]`) MUST have an inline `(evidence: ...)` annotation. Parenthetical references without the `evidence:` keyword (e.g. `(promote.ts, 13 tests)`) do NOT satisfy the rule — the stamp fails with "checked criteria lack inline (evidence: ...) annotation". Always format as: `- [x] <criterion text> (evidence: <file paths, commands, or test counts>)`. Commit the annotated criteria before running `rfc.implement.stamp`.

## Re-entrant werkstatt locks (RFC-0616)

`acquireLock` and `releaseLock` in `os/werkstatt/handlers/lock.ts` are re-entrant by PID. When the same process re-acquires a lock it already holds, `acquireLock` increments the `depth` counter instead of throwing. `releaseLock` decrements `depth` and only deletes the lock file when `depth` reaches `1` or is `undefined`. The `depth` field is `.optional()` in `werkstattLockSchema` — old lock files without `depth` parse successfully and are treated as `depth=1` via `?? 1` fallbacks. Agents MUST NOT assume `acquireLock` always throws on an existing lock file — it only throws when a **different** live process holds the lock.

## forge.yaml (RFC-0391)

`forge.yaml` is the machine-readable project configuration file at the project root. It records project name, stack, package manager, and docs paths. `create` creates it; `doctor` checks for it; `forge.agents.generate` reads it to produce `AGENTS.md`.

- **MUST NOT** run `forge.agents.generate` against this monorepo's root `AGENTS.md` — it is hand-written and carries no generated marker; the edit guard enforces this, do not bypass it.
- **MUST NOT** re-add any `@warpgogol/*` import to `packages/forge` source — `doctor` autonomy guard will fail.
- **MUST NOT** hand-edit a generated `AGENTS.md` in bootstrapped projects — edit `forge.yaml` and regenerate.

## Stack profiles (RFC-0392)

Stack profiles are YAML documents under `profiles/` describing a supported stack (detection markers, workspace layout, install steps, baseline files). `scaffold` creates a working pnpm + Turborepo monorepo from a chosen profile in an empty directory. The migration-adapter registry (RFC-0546) detects the stack of an existing project during `forge-bootstrap` transplant mode.

- **MUST NOT** scaffold into a non-empty directory — no `--force` flag.
- **MUST NOT** add stack profiles for stacks forge cannot scaffold end-to-end.
- **MUST** reference all template files in `profiles/<profile>-templates/` from the profile YAML (`workspaceTypes[].agentsMdTemplate` or `firstWorkspace.files`) or document them in the `agentsMdTemplate` file. Unreferenced template files are orphan artifacts that operators cannot discover.
- Shipped profiles: `astro-typescript-turborepo`, `phaser-turborepo`, `forge-shell` (minimal — default for `create`), `editframe` (video domain — first non-software profile, RFC-0641, React template RFC-0694).
- **MUST** include a `.github/workflows/ci.yml` template in every stack profile's `workspace.files` list. The CI template MUST include `concurrency` (cancel superseded PR runs), `permissions: contents: read` at workflow level, `timeout-minutes` per job, `env: TZ: UTC` per job, `actions/checkout@v5`, and `actions/setup-node@v5` with Node 24. New projects inherit reliable CI from the scaffold — operators should not need to hand-write CI from scratch.

### Domain fields (RFC-0638)

The `forge/stack-profile@1` schema includes six optional domain-neutral fields that allow a profile to declare its domain model. All fields are optional — existing profiles without them parse and function identically.

- **`domain`** — string identifying the project domain (e.g. `software`, `video`, `book`, `music`, `game`, `illustration`). Used for profile detection and doctor output.
- **`terminology`** — map of universal concept keys to domain-specific terms (e.g. `artifact: "composition"`). Open vocabulary; universal keys have built-in defaults exported as `TERMINOLOGY_DEFAULTS`. Missing keys fall back to the default term.
- **`artifacts`** — array of artifact definitions (id, extensions, produce/validate commands, determinism properties). Used by `doctor` for domain-specific health checks in follow-up RFCs.
- **`workspaceTypes`** — array of workspace type definitions (id, detection markers, associated skills, AGENTS.md template). Used by `forge.agents.generate` for per-domain workspace detection in follow-up RFCs.
- **`invariants`** — array of domain-specific invariant definitions (id matching `^[A-Z]+-\d+$`, rule text, severity). Schema only — enforcement is deferred to follow-up RFCs.
- **`register`** — string selecting the default behavioral register (`business` or `creative`). Used by `create` as a one-time default for new projects; existing `PREFERENCES.md` is never overwritten.

Types and schemas are exported from `@warpgogol/forge`: `StackProfileDomainFields`, `ProfileArtifact`, `ProfileWorkspaceType`, `ProfileInvariant`, `stackProfileDomainFieldsSchema`, `UNIVERSAL_TERMINOLOGY_KEYS`, `TERMINOLOGY_DEFAULTS`.

### Domain-aware commands (RFC-0640)

The following commands are domain-aware — they read domain fields from the stack profile and `forge.yaml` to adapt their behavior:

- **`profile.validate`** — validates profile YAML files under `packages/forge/profiles/` against the `forge/stack-profile@1` schema (including RFC-0638 domain fields). Supports `--id <profile-id>` to validate a single profile. Returns exit 1 if any profile is invalid.
- **`create`** — reads `domain`, `terminology`, `register`, and artifact-derived semantic bindings from the selected profile and writes them into `forge.yaml` (domain, terminology, bindings.commands) and `PREFERENCES.md` (register). When the profile has no domain fields, behavior is unchanged (software-domain fallback).
- **`doctor`** — reports domain info (domain, source, register, terminology, invariant count) as a `domain-info` check. Enforces profile invariants via the invariant engine as a `domain-invariants` check (RFC-0675) — invariants with a `check` declaration are actively verified (`filename-pattern`, `file-contains`, `file-not-contains`, `attribute-pattern`); invariants without `check` remain advisory. The `attribute-pattern` check kind (RFC-0694) validates attribute values on elements matching a tag selector — requires `elements` (array) and `attribute` fields (schema-enforced via `.refine()`). Reports `fail` for error-severity violations, `warn` for warning-severity. The `--strict` flag elevates `warn` to `fail` for `domain-invariants` and `profile-validate` checks. `--json` includes `invariantViolations` array in the `domain-invariants` check. Runs `profile.validate` as an advisory `profile-validate` check (warn status on failure, not gating — shipped profiles are forge-internal). Nested AGENTS.md check runs for all domains — profile-driven workspace types replace hardcoded detection when present. Domain is resolved via a three-tier chain: `forge.yaml` `project.domain` → stack profile `domain` → default `software`.
- **`forge.agents.generate`** — loads `workspaceTypes[]` from the matching stack profile and passes them to `discoverWorkspaces` for profile-driven workspace type detection. When the profile has no `workspaceTypes`, falls back to hardcoded detection (astro.config → app, Dockerfile → service, else package).

### Per-domain AGENTS.md templates (RFC-0643)

`forge.agents.generate` uses profile terminology and register to produce domain-appropriate AGENTS.md files. When no profile is loaded (or the profile has no domain fields), output is identical to the pre-RFC-0643 implementation — no regression for existing software-domain projects.

- **Root AGENTS.md templates**: Static prose (header, project section, paths section, conventions) is extracted to template files at `src/onboarding/templates/root-agents-business.md` and `root-agents-creative.md`. `selectRootTemplate(register)` returns the appropriate template. Dynamic sections (skills table, capabilities, behavioral layer) remain inline and are inserted at the `{{dynamicSections}}` marker.
- **Nested AGENTS.md templates**: `selectNestedTemplate(workspaceType, profile, terminology, fallback)` reads `workspaceTypes[].agentsMdTemplate` from the profile. Template paths are relative to `packages/forge/profiles/`. Absolute paths and parent-directory traversal (`..`) are rejected with a silent fallback to the hardcoded template.
- **Terminology substitution**: `substituteTemplate(content, terminology)` replaces `{{terminology.key}}` placeholders with resolved values. Runs on the final assembled content (after dynamic sections are appended), so the behavioral layer's fixed policy text also receives terminology substitution. Unknown keys resolve to the key name itself — no error.
- **`{{terminology.key}}` placeholder syntax**: AGENTS.md templates use `{{terminology.key}}` (double-brace), not `ref(bindings.terminology.key)` (skill syntax). The two are documented separately.
- **`details` field in `--json` output**: `AgentsGenerateResult` includes an optional `details` array with per-file metadata: `{ path, domain?, register?, workspaceType? }`. The `generated` field remains `string[]` for backward compatibility.
- **`profile` field in `forge.yaml`**: `create` writes `profile: <id>` to `forge.yaml`. `loadForgeConfig` loads the corresponding `profiles/<id>.yaml` and attaches it as `config.profile` (a `StackProfile` object). The profile object is stripped before serialization — `forge.yaml` stores the profile id (string), not the full profile.
- **Template comments MUST NOT use literal `{{placeholder}}` syntax**: `replaceProjectPlaceholders()` runs on the entire template content, including HTML comments. A comment like `<!-- inserted at {{dynamicSections}} -->` will have the placeholder replaced with the full dynamic sections content, breaking the comment and inflating the output. Use plain text names (e.g. `dynamicSections marker`) in comments instead of `{{...}}` syntax.
- **All template content MUST be external files, not inline `lines.push()` string arrays.** Fixed prose and policy text in forge generators (e.g. `agents-generate.ts`, `nested-agents-templates.ts`) must live in `.md` template files under `src/onboarding/templates/` or `profiles/`, loaded via `fs.readFileSync` with placeholder substitution. Inline `lines.push("### Section heading")` patterns for fixed text are a contract violation — they embed template content in source code, making it harder to review and maintain. Dynamic, data-driven content (tables generated from registry data, conditional sections from config) remains inline.
- **Template files read at runtime via `fs.readFileSync` MUST be listed in `package.json` `files` array.** TypeScript compilation (`tsc`) does not copy `.md` template files to `dist/`. Without an explicit `files` entry, template files exist on disk in development but are missing from the published npm package — the generator silently falls back to empty content. The test `src/tests/package-files.test.ts` guards this: it verifies that `src/onboarding/templates/` is in the `files` array and that all expected template files exist and are readable.
- **Profile object stripping before YAML serialization**: `loadForgeConfig` attaches a full `StackProfile` object to `config.profile`. Before serializing the config back to YAML (e.g. in `create` post-processing), the profile object MUST be stripped back to its string id. Otherwise `forge.yaml` contains an object instead of a string and fails schema validation on re-read.
- **Profile invariant `rule` fields containing colons MUST be double-quoted.** YAML plain scalars with colons (e.g. `rule: mode attribute must be one of: sequence, fixed, contain, fit`) cause "Nested mappings are not allowed in compact mappings" parsing errors. Always quote rule fields that contain colons: `rule: "mode attribute must be one of: sequence, fixed, contain, fit"`. This also applies to any other YAML string field in profile YAML that may contain colons.

## Bindings contract (RFC-0393)

The `bindings` section in `forge.yaml` de-hardcodes project-specific values from fo-skills. Skills reference bindings by key (e.g. `ref(forge.yaml bindings.commands.validateRfc)`) instead of hardcoding commands, paths, or terminology.

- `forgeBindingsSchema` + `resolveBinding(config, key, placeholders?)` are exported from `@warpgogol/forge`.
- `doctor` validates bindings: checks path existence, reports resolved/absent/invalid, and emits `defaultable-binding-null` notices for forge-CLI-backed bindings that are null (RFC-0540).
- `create` writes forge-CLI-backed defaults for commands forge provides (`validateRfc`, `validateAdr`, `implementStamp`, `specValidate`) and null for stack-dependent commands (`typecheck`, `test`, `scopedBuild`). The package manager from `forge.yaml` determines the runner prefix (`pnpm exec`, `npx`, `yarn exec`, `bunx`).
- `skill.validate` enforces SKILL-11: canonical skill bodies must not contain hardcoded `pnpm exec site-kernel run` or `docs/architecture-dna.md` in instruction lines (code blocks and `run:` directives). Supports `<!-- skill-lint-disable SKILL-11 -->` escape hatch.
- `skill.validate` enforces SKILL-17: skill files must not contain specific platform RFC/ADR ids (`RFC-\d{4}`, `ADR-\d{4}`) or platform names ("Warpgogol", "Warpgogol", "WarpGogol"). Generic "RFC"/"ADR" terms, generic placeholder ids (`RFC-XXXX`), file paths (`adr-0000-template.md`), and binding key names (`validateRfc`) are allowed. The `@warpgogol/forge` npm package name is excluded from the platform name check. Supports `<!-- skill-lint-disable SKILL-17 -->` escape hatch.
- `skill.validate` enforces SKILL-18: canonical forge skill bodies must not reference software-specific binding keys (`bindings.commands.typecheck`, `bindings.commands.scopedBuild`, `bindings.commands.test`) in instruction lines (code blocks and `run:` directives). Skills must reference semantic keys (`bindings.commands.validate`, `bindings.commands.produce`, `bindings.commands.verify`) instead. Supports `<!-- skill-lint-disable SKILL-18 -->` escape hatch. Applies to forge skills only, not pack skills.
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

All semantic keys are optional with `null` defaults. `applyCliBindingDefaults` initializes them with `null` (they are stack-dependent, not CLI-backed). `doctor` does **not** validate semantic keys — they are opt-in per-domain, so reporting them as `absent` for projects that intentionally leave them `null` would be noise. Skills reference them via `ref(bindings.commands.produce)` etc.

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
- `create` prints an IDE recommendation (Windsurf tested, alternatives without guarantee) after the Next steps block in pretty mode.
- All forge CLI natural-language output is English regardless of `PREFERENCES.md` — `aiLanguage` governs agent chat, not the forge binary.
- `printHelp` is generated from the registry via `generateHelp` — no hand-maintained command list. `--help <command>` prints per-command flags and description.
- `ForgeNextStep` type and `nextSteps?` field are on `ForgeCommandResult` directly (cross-cutting), not inside command-specific `data`.
- Lifecycle commands (`create`, `scaffold`, `doctor`, `port.scaffold`) MUST populate `nextSteps`. Pass-state validators MAY leave the array empty.
- Future commands (`create`, `upgrade`) MUST conform to the `nextSteps` contract from day one.
- Skill reports (agent chat output) use the operator's `aiLanguage` and contain zero CLI commands, guides, or format references in user-facing text. The system hides all complexity from the operator. CLI output remains English per RFC-0542; only the skill (agent chat) uses `aiLanguage`. The `forge-bootstrap` welcoming report is the canonical example of this contract.

## Silent upgrade trigger (RFC-0554)

The `forge-bootstrap` skill step 0 silently checks `forge.syncedVersion` against the installed `@warpgogol/forge` version. If they differ, it runs `forge upgrade --update-npm` invisibly — the operator is never informed about migration, version numbers, or upgrade mechanics. The npm update is skipped automatically in monorepo environments (where `packages/forge/` exists). The `upgrade` CLI command remains available for manual sync (with or without `--update-npm`). This is not a dual-path: it is a single upgrade mechanism (`runUpgrade`) with two entry points (CLI and `forge-bootstrap`).

## Core behavioral layer (RFC-0548)

`forge.agents.generate` now includes a **Core behavioral layer** section in generated `AGENTS.md` files. This section is wrapped in `<!-- forge:begin behavioral-layer -->` / `<!-- forge:end behavioral-layer -->` markers and contains:

- **Intent-to-skill routing table** — generated from `triggers` fields in fo-skill frontmatter. Each row maps natural-language trigger phrases to the corresponding skill.
- **Fixed policy text** for 20 core behavioral areas: auto-grilling, auto-session-save, auto-review, context awareness, creator-facing communication, adaptive learning, proactive guidance, live operator feedback, register parameter, pushback policy, external capabilities (MCP), safety net, invisible quality, first creation moment, creative health, sharing and feedback, cultural awareness, indirect teaching, ownership, and commit policy (RFC-0551).
- **Conditional extended behavioral layer** (RFC-0549) — included only when the register is `creative` (read from `PREFERENCES.md` `register` field). Contains ten sections: personal connection, creative memory, emotional rhythm (questions not declarations), gentle accountability, creative partnership, visual thinking, audience empathy, creative companion (companion mode, `saveCompanionSessions` flag, pull-only inspiration feed), creative confidence (outcome-based praise, never refuse creative direction), and always-next-step (RFC-0551, supersedes the "at most one per session" anticipatory suggestion limit). Content is loaded from `src/onboarding/templates/behavioral-layer-extended.md`.

`create` auto-runs `forge.agents.generate` after `forge.init`, so newly created projects get the behavioral layer from day one. If generation fails, a warning is logged but the create command continues.

The `triggers` field in skill frontmatter is validated by SKILL-16: optional array of 1-5 natural-language strings (each 5-100 characters), only allowed on fo-category skills. Pack skills may not declare triggers.

## Nested AGENTS.md generation (RFC-0611)

`forge.agents.generate` also generates nested `AGENTS.md` files for workspace directories (directories containing `package.json`). Workspace type is auto-detected by content markers:

- **app** — directory with `astro.config.*`
- **service** — directory with `Dockerfile` or `service.config.yaml`
- **package** — directory with `package.json` only
- Precedence: app > service > package

Workspace-type detection rules are defined in RFC-0611. Agents MUST NOT add new detection rules without an amending RFC.

The edit guard skips hand-written nested `AGENTS.md` files (no generated marker) and reports them in the `skipped` array. Generated files (with marker) are regenerated if content differs. `upgrade` also runs nested generation after skill sync. `doctor` checks for missing, stale (in-memory comparison), and hand-written improvement opportunities.

`forge.agents.generate` supports `dryRun` mode (RFC-0601 pattern): it renders content in memory without writing to disk, returning `renderedFiles` in the result. This is used by `doctor` for staleness detection.

- **Doctor stale check MUST use the same rendering pipeline as `forge agents generate`.** The stale check in `checkNestedAgentsMd` (`src/onboarding/doctor.ts`) must call `readPackageInfo` → `buildNestedAgentsMd(ws, config, packageInfo)` → `selectNestedTemplate(wsType, profile, terminology, fallback)` — exactly matching `generateNestedAgentsMd` in `src/onboarding/nested-agents-generate.ts`. Any divergence (missing `packageInfo`, missing `selectNestedTemplate`, missing `resolveAllTerminology`) causes false-positive stale reports for all generated nested `AGENTS.md` files. When modifying either function, verify the other stays in sync.

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

- `forgeSpecModule` (in `os/spec/`) registers `spec.validate`, `spec.status`, `spec.materialize`, `spec.live.merge`, `spec.live.list`, `spec.live.show`, `spec.live.validate`.
- `spec.validate` enforces SPEC-01..07: integrity, schema, cycles, references, waves, duplicates, materializedAs.
- `spec.materialize` scaffolds RFC files for front nodes with `specRef` traceability and writes `materializedAs` back to `forge-spec.yaml`.
- `spec.status` projects per-node states, blockers, and progress.
- Spec amendments (`docs/specs/<id>/amendments/amd-NNN-*.md`) are the only correction channel — snapshot files are never modified.

### Living feature specs (RFC-0711)

Living feature specs are mutable markdown documents under `docs/specs/live/<domain>.md` that reflect the current specification of a feature or module. Unlike vendored spec snapshots (DNA-55), living specs evolve through delta merges from archived RFCs.

- `spec.live.merge --id <RFC-XXXX>` extracts headings from the RFC's `## Design` section and merges them into the corresponding living spec. All-or-nothing: aborts on any heading conflict without writing. Use `--dry-run` to preview.
- `spec.live.list` lists all living specs with domain, title, lastMergedRfc, and history count.
- `spec.live.show --domain <name>` reads and returns a single living spec.
- `spec.live.validate` validates all living specs with rules V-LS-01..05 (frontmatter, domain/filename match, archived RFC references, history integrity, duplicate domains).
- `docs.archive` automatically calls `spec.live.merge` for implemented RFCs with `liveSpec` frontmatter field after archiving. Rejected RFCs with `liveSpec` are skipped.

## NPM publish workflow

To publish a new version of `@warpgogol/forge` to NPM:

1. Bump `version` in `packages/forge/package.json` (semver: minor for new skills/features, patch for fixes).
2. Bump `forge.syncedVersion` in `forge.yaml` to match.
3. Run `pnpm --filter @warpgogol/forge publish --access public --no-git-checks` — publishes to `@warpgogol/forge` on npmjs.org.
4. Commit version bumps: `git add packages/forge/package.json forge.yaml && git commit -m "release: @warpgogol/forge@<version>"`.

The `prepublishOnly` script runs `clean → build → publish-check → strip-workspace-deps` automatically. **`strip-workspace-deps.mjs`** removes `@warpgogol/*` `workspace:*` dependencies from `package.json` before publish — these packages are not on npm and would make the published package uninstallable. The `postpublish` script restores the original `package.json` via `git checkout -- ./package.json`.

**Do NOT use `npm publish`** — it fails during `prepublishOnly` because `tsc` cannot resolve workspace dependencies (`@warpgogol/share/fs`, `@warpgogol/fingerprint`) outside the pnpm workspace context. `pnpm publish` handles workspace dependencies correctly.

**Workspace deps must use dynamic imports.** `@warpgogol/*` packages that are not published to npm MUST be imported via dynamic `import()` (see `os/core/handlers/workspace-deps.ts`), never static `import`. Static imports would fail at runtime when forge is installed standalone from npm. The `workspace-deps.ts` helper caches the dynamic import and throws a clear error message if the packages are missing.

### `.npmrc` token precedence

When publishing `@warpgogol/forge`, npm resolves the auth token from `.npmrc` files in precedence order: `packages/forge/.npmrc` (project) > `werkstatt/.npmrc` (workspace root) > `~/.npmrc` (user). A stale token in `packages/forge/.npmrc` silently overrides valid tokens in the other files. npm returns `404 Not Found` (not `403 Forbidden`) on PUT when the token lacks publish permissions — this is a deliberate npm security behavior that masks auth failures as missing resources. When rotating npm tokens, update ALL `.npmrc` files that contain a token, starting with `packages/forge/.npmrc`. All three files are gitignored.

## Git command patterns in forge handlers

- **`git log --oneline` output includes a hash prefix** — the format is `<hash> <message>`, not `<message>`. When matching commit message patterns in `--oneline` output, do NOT anchor the regex to `^implement:` or `^feat:` — the line starts with the hash. Use a non-anchored pattern like `implement:\s+RFC-\d{4}\b` instead. Discovered during RFC-0625 V-32 implementation where `^implement:` failed to match `--oneline` output.
- **`execGit` helper pattern** — multiple forge handlers (`implement-stamp.ts`, `verification-evidence.ts`, `validate-rules.ts`, `validate.ts`) each define their own `execGit`/`execGitLog` helper wrapping `execFile("git", ...)`. These are candidates for extraction into a shared `os/utils/git.ts` utility.

## CLI invocation and test fixtures

- **Running forge CLI commands on the workspace root** — `pnpm --filter @warpgogol/forge exec forge <command>` runs from the package directory (`packages/forge/`), where `forge.yaml` is not found. To run forge commands against the workspace root (e.g. `doctor`, `rfc.validate`, `upgrade`), use `node packages/forge/bin/cli.js <command>` from the workspace root instead.
- **Golden fixture for `agents-generate`** — when adding or modifying sections in `agents-generate.ts`, the golden fixture `src/tests/fixtures/agents-generate-business-before.txt` MUST be updated to match the new generated output. The test `agents-generate-domain.test.ts` compares generated content against this fixture with `expect(content).toBe(goldenFixture)` — a mismatch fails the test.
- **SKILL-17 brand pattern must be case-sensitive** — the brand regex in `skill-validate.ts` uses a `@`-lookbehind to allow `@warpgogol/<pkg>` npm-scope references in skill instruction lines. Making the regex case-insensitive (`/gi`) defeats the lookbehind and false-flags every `@warpgogol` import as a brand violation. Keep the regex case-sensitive (`/g` only) so the `@`-scope allowance works correctly.
- **`vi.resetModules()` before `vi.doMock()` for Node builtins** — when mocking Node built-in modules (e.g. `node:child_process`) in vitest, `vi.resetModules()` MUST be called BEFORE `vi.doMock()`. Without `resetModules()` first, the module cache retains the original module and the mock is not applied on re-import via dynamic `import()`. After the test, call `vi.doUnmock()` and `vi.resetModules()` to restore. Discovered during `upgrade.test.ts` `--update-npm` mock testing.
- **Mock `execSync` for scaffold tests** — `runScaffoldProject` calls `execSync` to run `pnpm add` install commands, which fail in test environments without network access. Mock `node:child_process` with `vi.mock("node:child_process", async (importActual) => { const actual = await importActual(); return { ...actual, execSync: vi.fn(() => Buffer.from("mocked")) }; })` and use dynamic `await import("../onboarding/scaffold-project.ts")` after the mock. Use `vi.importActual` to preserve `execFile` (used by `promisify(execFile)` in forge/os/compass). See `src/tests/editframe-e2e.test.ts` for the reference pattern.
- **`runDoctor` profile resolution in tests** — `runDoctor` calls `resolveForgeRoot(workspaceRoot)` which searches for `packages/forge/` relative to the workspace root. In temp-directory tests, the forge package is not found, so profile-dependent checks (prerequisites, invariants) are silently skipped. Either pass `forgeRoot` in the `ForgeRuntimeContext` (preferred), or create a minimal `packages/forge/profiles/<id>.yaml` inside the temp directory. See `src/tests/editframe-e2e.test.ts` "doctor checks prerequisites" test for the local-profile pattern.

## RFC frontmatter: versionBump for prose-only policy RFCs

Prose-only policy RFCs (skill-text-only, no code/command/contract changes) MUST set `versionBump: none`, not `patch`. The `patch` value over-reports the SemVer impact — there is no runtime or API surface change. This was a recurring audit finding across RFC-0669, RFC-0670, RFC-0671, RFC-0672, and RFC-0673 (5 consecutive RFCs). Set `versionBump: none` at creation time for `kind: policy` RFCs that only modify `.md` skill files.

## RFC frontmatter: file system responsibilities table

Skill-text-only RFCs MUST include `packages/forge/AGENTS.md` in the file system responsibilities table with the note "No change needed — documents skill infrastructure, not individual skill behavior." This preempts a recurring audit finding (5 consecutive RFCs). The `packages/forge/AGENTS.md` file documents skill infrastructure (sync paths, validator rules, import constraints), not individual skill behavior — so it never needs updating when a skill's text changes.

## rfc.create title reuse

`rfc.create` may reuse the title from a previous invocation in the same session. After creating an RFC, always verify the generated filename matches the intended title before populating content. If the filename is wrong, delete the file and re-run `rfc.create` with the correct `--title`. Do not rename the file — the RFC ID is assigned by the command and must not be manually changed.

## Profile-driven RFC conventions

All profile-driven RFCs (RFC-0674 onwards) MUST follow these conventions:

- **CLI flags**: every proposed command MUST support `--dry-run`, `--json`, and `--profile` flags. These are the standard Forge lifecycle flags.
- **Schema extensions**: all new profile schema fields MUST be optional (`z.optional()`) — existing profiles must continue to validate without changes.
- **No domain-specific logic in Forge core**: all behavior is driven by profile YAML declarations. Forge source must not import domain-specific packages or hardcode domain-specific rules.
- **File system responsibilities table**: every profile-driven RFC MUST list `packages/forge/src/profiles/profile-schema.ts` and `packages/forge/os/core/core.module.ts` in the table.

## Workflow file placement

Workflow files MUST live only in `.agents/workflows/`. Do NOT duplicate workflow files in `.windsurf/workflows/` — `.windsurf/workflows/` is IDE-specific config that does not ship to new projects via `create`. `.agents/workflows/` is the single source of truth for workflow definitions.

## Workflow files vs skill content

IDE-specific workflow files (`.windsurf/workflows/`, `.devin/workflows/`) MUST NOT duplicate skill content. Skills (`packages/forge/skills/`) are the portable unit — they ship to every new project via `create`. Workflow files are IDE-specific triggers that reference skills by name; they should not contain the protocol itself. If a workflow file grows beyond a trigger phrase + skill reference, move the content into the skill's `SKILL.md`.

## Kernel command handler pattern: pure function + thin handler

When a kernel command's logic needs to be called from two contexts — (1) a pipeline step via `KernelRuntimeContext` and (2) directly from another package without kernel types — split into a pure function + thin kernel handler.

- **Pure function**: `ensureThing(workspaceRoot: string, logger: { info: (msg: string) => void }): Promise<Result>` — no kernel types, callable from any package.
- **Thin kernel handler**: `runThing(input: KernelCommandInput, context: KernelRuntimeContext): Promise<KernelCommandResult<Result>>` — calls the pure function, wraps result in `KernelCommandResult`, catches errors → `exitCode: 1`.

This avoids the fragile alternative of calling a kernel handler with synthetic `input`/`context` from non-kernel code. The pure function is the reusable unit; the handler is the pipeline/CLI adapter.

**Custom result types:** When a kernel command returns a custom data type (not `CheckResult`), you cannot use `failResult`/`passResult` from result helpers — they return `KernelCommandResult<CheckResult>`, not your type. Build the `KernelCommandResult` manually: `{ data: result, exitCode: 0, summary: "ok" }` for success, `{ data: { ...nulls }, exitCode: 1, summary: msg }` for error.
