# Changelog

All notable changes to `@warpgogol/forge` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For the full commit history, see the [GitHub releases page](https://github.com/syrokomskyi/forge/releases).

## [8.0.3] — 2026-10-19

### Fixed

- **`session.save` metadata extraction** (xrepo handoff from personal-agent): a hex token is recorded under `commits:` only when it resolves to a commit object in the workspace repository — candidates are batch-verified via `git cat-file --batch-check <token>^{commit}`, so random hex ids (approval ids, checksums, foreign-repo shas) are no longer claimed as commits. Path tokens captured from enumerated prose no longer keep trailing sentence punctuation (`:`, `,`, `;`, `.`, `)`, `]`, …) — `packages/agent/data/agent.db:` is now stored as `packages/agent/data/agent.db`.

## [8.0.2] — 2026-10-19

_Major line 8: verification evidence is now checked against git history and independent verification. `rfc.implement.stamp` gains blocking gates (RFC-IMP-10/11/12), and the `amend` command family is removed. 8.0.0 and 8.0.1 were never published; 8.0.2 is the first 8.x release on npm._

### Added

- **Git-derived probe origin** (`os/rfc/verification-origin.ts`): every probe in the verification envelope carries a derived origin (`self`, `verifier`, `unchanged`, `unresolved`, `presence`), computed from the range between the `status: accepted` transition and HEAD. V-44 rejects WHEN/IF criteria that are evidenced only by presence probes.
- **Stamp gates**: RFC-IMP-10 blocks a declared `expectationSource` that git contradicts. RFC-IMP-11 blocks `verificationTier: high` RFCs when a behavioral criterion has no non-self probe. RFC-IMP-12 requires a committed, passing, subagent-isolated acceptance-verification report; the operator can waive it with `--waive-independent-verification`.
- **`rfc.verify.workspace`**: exports a committed candidate as a tree without git metadata, with self-authored tests and RFC plan, review and session documents removed, for independent acceptance verification.
- **`probe: reachable`** (symbol and command modes), plus a V-45 warning for exported symbols that nothing reaches.
- **`verifyReproduction` binding** and reason-gated test guidance in `fo-idea-implement`, `fo-add-tests` and `fo-fix`. Acceptance-verification mode in `fo-review`.
- **`rfc.implement.stamp --check-criteria`** flips evidenced criteria atomically with the stamp. **`rfc.evidence.sync`** resyncs evidence in one command. **`compass.header.scaffold`** codemod.
- **Compass comment-terminator safety** (COMPASS-CS-08): authored text that would end a comment early is rejected, injected text is neutralized, and `summary.record` reports `neutralized`.

### Changed

- `rfc.verification.emit` checks that generated artifacts are fresh (EVIDENCE-FRESH-01/02/03).
- Governance ids are matched case-insensitively.
- Git subprocesses ignore repository-locating `GIT_*` variables inherited from the environment.

### Removed

- The `amend` command family.

## [7.0.0] — 2026-10-13

_Major: `rfc.implement.stamp` now enforces the RFC-IMP-09 stale-evidence gate and writes the verification envelope itself — the stamp contract and its declared `writes[]` change. The agent operating model ships as a synced normative document and reaches generated `AGENTS.md`._

### Added

- **Evidence-driven agent operating model** (`skills/_shared/agent-operating-model.md`, synced to `.agents/skills/_shared/` by `forge upgrade`): EXPLORE/ROUTINE/GOVERNED work modes, authority boundaries and escalation triggers, a proportionate verification portfolio (STANDARD/HIGH/FORMAL tiers — proportionate checks, not mandatory TDD), expectation-source classes for probes, the evidence trust boundary, and the IMPLEMENTED/VERIFIED/ACCEPTED/RELEASED completion vocabulary
- **RFC-IMP-09 stale-evidence gate** in `rfc.implement.stamp`: recomputes `rfcFileHash` + `acceptanceHash` before mutation and blocks on mismatch, missing hash fields, post-emit probe deletion, or malformed/non-object envelopes (fail-closed)
- **Post-stamp evidence re-emit**: stamping a probe-bearing RFC re-emits its verification envelope in-process after the frontmatter mutation — a stamped RFC never ships a born-stale envelope (`evidenceReEmitted` in the result payload)
- **`rfc.verification.emit --check`**: recomputes evidence and compares the committed envelope on non-volatile fields (`rfcFileHash`, `acceptanceHash`, `probes.length`, `probes[].ok`, `overall`) — exits non-zero with named `mismatches` on divergence or a missing envelope; no writes
- **Probe metadata**: optional `expectationSource` (`self|requirement|independent|external`) and `limitations` on every acceptance-probe kind; optional RFC frontmatter `verificationTier` (`standard|high|formal`, V-43)
- **Skill schema**: optional `notApplicableWhen` and `costNotes` frontmatter fields; `fo-idea` declares `notApplicableWhen` and labels its routing outcomes with work modes
- **Behavioral layer**: generated `AGENTS.md` gains a "Work modes and completion vocabulary" section
- **V-23 archive exemption**: `docs/rfcs/archive/**` no longer blocks validation on historical failed envelopes (archive-freeze precedent)

### Changed

- `normalizeProbes` serialization is now a full recursive key sort with no key filtering — `acceptanceHash` binds the complete probe identity including nested `expect`/`schemaInline` fields; exported for the stamp-side recompute (envelopes emitted before 7.0.0 read as stale once — one `rfc.verification.emit` re-emit heals them)
- `rfc.implement.stamp` declares `docs/rfcs/verification/*.generated.yaml` in `writes[]` (it owns the post-stamp re-emit)
- EXPLORE-mode gloss aligned across the behavioral template and the normative document: isolated-scope experiments permitted, no writes to durable surfaces
- RFC template probe examples carry `criterion:` bindings and the `werkstatt run` command prefix required by the shape validator
- `rfc.implement.stamp` repair hints name the real fixes (re-emit; for probe deletion: restore probes first or remove the stale envelope)

## [6.3.6] — 2026-10-12

### Fixed

- Knowledge sync reports conflicts only when duplicate IDs carry different title, body, or metadata; identical records with reordered metadata fields no longer produce false conflict warnings

## [6.3.5] — 2026-10-12

### Fixed

- `spec.validate` sweep mode scopes to manifest-bearing dirs — directories without `forge-spec.yaml` (authored spec work areas, `docs/specs/live/`) are skipped instead of failing SPEC-02, matching the vendored-packages contract; skipped dirs surface as `skippedDirs` on `SpecValidateResult` and a pretty-output info line (xrepo handoff `xrepo-personal-agent-to-forge-spec-validate-sweep`)
- `--spec=<id>` keeps SPEC-02 when the named dir lacks a manifest; present-but-corrupt manifests still fail SPEC-02 in sweep mode — the skip is by file presence, not parseability
- Docs: agent-guide note on conditional mid-pipeline generates, `context.site` trust, and commit-guard scope semantics

## [6.3.4] — 2026-10-12

_Bumped in-monorepo but never exported or published — superseded same-day by 6.3.5._

## [6.3.3] — 2026-10-11

### Fixed

- `compass.docs.scaffold` derives workspace node id prefixes from directory location (`apps/*` → `app-*`, `packages/*` → `pkg-*`, `services/*` → `svc-*`, dotted elsewhere) instead of detected workspace type — type-derived `pkg-*` ids failed `COMPASS-DOC-02` validation on `apps/` workspaces, so fresh scaffold output now validates clean with zero manual edits
- `forge.agents.generate` emits the "Semantic layer — read first" block into nested generated workspace guides, not only the generated root `AGENTS.md`
- Hand-written `AGENTS.md` files can opt in to the semantic-layer block via the `<!-- forge:semantic-layer -->` sentinel — expanded into a marker-wrapped `forge:begin/end semantic-layer` region that `agents.generate`, `upgrade`, and `doctor --fix` refresh in place without touching surrounding prose; result gains an `injected[]` field and doctor reports injections as fixes
- Docs: `docs/reference/compass-docs.md` documents the workspace id convention and the hand-written opt-in sentinel

## [6.3.2] — 2026-10-10

### Added

- `forge.package.health` publish-readiness gates (RFC-1255): PKG-HEALTH-07 generated-CI script contract (`build`/`lint`/`typecheck`/`test` must exist when `ci.provider` is set), PKG-HEALTH-08 `repository.url` vs `git.remote` slug match for npm provenance, PKG-HEALTH-09 `files[]` src-reachability coverage; `"extractable": false` package.json opt-out for consciously non-extractable published packages
- verify-extract changelog gate — publish flow requires a `CHANGELOG.md` section for the target version
- `resolveWorkspaceTypes` shared helper — prettierignore plan enumerates generated AGENTS.md paths; `forge.doctor` emits severity-aware next-steps and a forge-version-sync warning

### Fixed

- Scaffold `kernel.config.ts` via `forgeModuleLoaders` — stale `forgeXModule` consts silently dropped every module (masked as command-not-found)
- Sync `skills/_shared/` convention docs to npm consumers on `forge init`/`upgrade` — `fo-*` SKILL.md references no longer dangle
- Generated-header `Regenerate` hint dedupes the command-prefix namespace (`forge forge.agents.generate` → `forge agents.generate`); single blank line after generated headers (doctor stale-check ping-pong)
- `forge.package.health` — `WorkspaceIO` type import routed through the inlined ADR-0019 copy (standalone typecheck green)
- Test suite covered by typecheck — tsconfig split into noEmit base + `tsconfig.build.json`, 23 latent type errors drained
- Bump `@warpgogol/repo-extract` to `^1.5.0` — RFC-0132 self-healing standalone manifests + NPM_TOKEN bootstrap

## [6.3.1] — 2026-10-10

### Fixed

- `forge.package.health` — PKG-HEALTH-02 retuned to the repo-extract generated-CI model (RFC-1254); extractable packages declare their standalone lint tooling

## [6.3.0] — 2026-10-10

### Added

- Compass corpus docs lifecycle (RFC-1253): `compass.docs.scaffold` + `compass.docs.validate` commands, corpus templates, `--compass-docs` flag on `forge create`/`init`/`upgrade`, doctor convention notices for corpus docs outside `docs/` with a scaffold remediation hint, `forge.validate` `compassDocs` section feeding `allPassed`, and `forge.agents.generate` emits a "Semantic layer — read first" block when `paths.compassDocs` resolves
- `forge.package.health` lint-surface probe — PKG-HEALTH-06 (RFC-1254)
- `diagnostic.rule-id.validate` gate — RULEID-CANONICAL-01 (RFC-1251)

## [6.2.0] — 2026-10-10

### Fixed

- `compass.docs.validate` glob — closed an unused-var lint defect reintroduced by the RFC-1249 sweep (standalone lint green again)

## [6.1.0] — 2026-10-10

_Exported but not published to npm — superseded same-day by 6.2.0._

### Added

- Export-pipeline hardening (RFC-1252): CI-parity `verify-extract`, `--from-head` publish path, `autoReconcile` on `autoPush` remotes, `extraGitignore` dest-side shield, EC-20 staged-file lint gate in `ecosystem.commit`
- `werkstatt.commands.validate` wired into `packages.check` (RFC-1249)

### Fixed

- Standalone lint failures at HEAD left by the RFC-1250 publish wave

## [6.0.0] — 2026-10-09

### Changed (breaking)

- **RFC-1250: front-loaded operator decisions.** Orchestrated document runs are restructured into four phases — maturation → decision window → resolution → execution. Every run materializes a queue manifest (a single document is a one-item queue), all operator-facing questions are collected into a durable append-only ledger `docs/queues/<id>.decisions.yaml` instead of asked inline, and answers are applied in a single consolidated decision window that doubles as the batch acceptance ceremony (`draft→accepted` moves to the resolution phase). There is no compatibility mode for per-item inline asking inside orchestrator runs.
- `queue.validate` gains **QUEUE-07** (blocking: implementable item with un-parked `open` decisions), **QUEUE-08** (ledger hygiene warnings), ledger↔manifest binding checks (QUEUE-02 family) and `Q-N` uniqueness (QUEUE-05); `next` skips deferred/parked/QUEUE-07-blocked items with a transitive `dependsOn` cascade; JSON output gains per-item and top-level `decisions` totals.
- Pipeline skills gain a `collect`/`finalize` contract (`interview` stays for standalone invocations); `grilling` gains `emit` mode; emergent execution questions auto-resolve with ledger logging — only the closed hard-stop class (DNA, security/privacy, external contracts, irreversible ops, exhausted hard-block) parks an item.

## [5.3.4] — 2026-10-07

### Added

- `forge.doctor` warns on unmanaged skill directories under `skillsDir` — SKILL.md-bearing dirs without a `.forge-managed` marker (RFC-1226)
- `skill.validate` resolves the forge root via `resolveForgeRoot` (RFC-1225); SKILL-17 exempts comment regions (RFC-1227)

### Changed

- `forge.upgrade` preserves operator `forge.yaml` content; `adrImplementStamp` binding promoted (RFC-1224)
- Governance-ID tail widened to accept mission IDs in `<history>` blocks; fail-closed guards on unparseable history tokens (RFC-1220)

## [5.3.3] — 2026-10-06

### Changed

- `fo-idea-plan` skill auto-decides design summits without an operator prompt

## [5.3.2] — 2026-10-04

_No user-facing changes — post-ship version sync._

## [5.3.1] — 2026-10-04

### Fixed

- Standalone CLI flag resolution is schema-driven — a value-less declared flag (e.g. `forge rfc.validate --id`) exits with KERNEL-FLAG-02 instead of crashing; kind-string flags repeated on the command line emit KERNEL-FLAG-02 instead of silently promoting to arrays, while inline values containing `=` are preserved via indexOf split
- Routing table empty for npm consumers — `extractTriggerPhrases` resolves the installed package root
- Generated `hooks.json` falls back to `PWD` when `ROOT_WORKSPACE_PATH` is unset
- `.agents` drift gate tolerated missing `forge.yaml` (standalone skip)
- `WorkspaceIO` port types inlined into `src/types.ts` (ADR-0019) — keeps `npm install` dependency-free in the standalone export

## [5.3.0] — 2026-09-30

### Changed (breaking)

- Skill `SKILL.md` frontmatter `triggers` renamed to `triggerPhrases` — agent-IDE loaders reserve `triggers` for invocation modes

### Added

- Managed `.prettierignore` block for forge-owned generated paths (RFC-1154): marker-driven skill entries, `**/*.generated.yaml`, `docs/sessions/`, `docs/metrics/`, `docs/queues/session-*.yaml`; `.forge-managed` marker manifests with prune; prettier-normal `alignMarkdownTable` emitter
- Editable generated files merge at a `forge:custom` boundary (RFC-1153) — content below the boundary is preserved on regeneration; canonical-footer fallback; `unmapped-customization` skip
- `generates` field on commands — 47 commands declare real marker-bearing artifacts; GENERATES-MISSING sweep
- `mutatesState` declared on all kernel commands (RFC-1173); registry-integrity ratchet closed — `execOnReadOnly` + `mutatingFlags` contracts, `io.readonly` marker, honest `writes[]` (RFC-1176)
- `WorkspaceIO` port propagated across forge utils/handlers (RFC-1152) — kernel callers pass `context.io`, standalone CLI uses an ambient adapter

## [5.2.4] — 2026-09-24

_No user-facing changes — session-end version sync._

## [5.2.3] — 2026-09-24

### Fixed

- `forge.upgrade`/`forge.init` knowledge-file sync is append-only — project-accumulated `K-NNNN` entries are no longer wiped
- Dropped dead provider site-union member and `siteName` from `ForgeRegisteredCommandInfo`
- Unused `MISSION_FILE` constant removed in compass-audit-plan test

## [5.2.2] — 2026-09-24

_Not published to npm — internal version sync; changes listed under 5.2.3._

## [5.2.1] — 2026-09-23

_Not published to npm — changes shipped in 5.2.3._

### Added

- Typed flag schemas on 28 commands + required-flag mentions in 90 command descriptions — KERNEL-FLAG-05/06 (RFC-1145)
- Ledger-eligibility filter applied in compass audit validate/plan/record (RFC-1143)
- CLI hint accuracy and agent-safety hygiene — `rfc.create` hint, EC-14-PARTIAL, amend delegation, ledger scope (RFC-1139)
- Pipeline hygiene — module-scoped exempt entries, archive gitignore guard, promote auto-sync, `rfc.create` claim protocol (RFC-1138)

## [5.2.0] — 2026-09-23

### Added

- `queue.validate` — validates `docs/queues/*.yaml` manifests and reports derived per-item pipeline status; shared resolver; queue module registered (RFC-1140)
- Queue mode — manifest materializes at invocation from a pasted document list

## [5.1.3] — 2026-09-23

### Added

- `site-workshop` stack profile + npm token probe (RFC-1125)
- ADR-IMP-02 acceptance-criteria gate on `adr.implement.stamp`
- `pinned.validate` exempts intra-dir moves
- Fail-closed unresolvable declared profile id (RFC-1118)

### Fixed

- RFC validation closeout — V-28 createdAt monotonicity, supersession lifecycle (V-12/16/17), link integrity (V-19), probe command prefix (V-22), reviewer/evidence/frontmatter fields, kebab-case filenames (V-21), generated projections excluded from scan, terminal statuses exempt from V-32
- forge↔engine package cycle broken — fingerprinting bridges via `@warpgogol/werkstatt-shared`
- Compass leaf-workspace scan paths normalized so workpiece exclusion globs match

## [5.1.2] — 2026-09-19

_Internal version sync — changes listed under 5.1.3._

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

## [4.2.4] — 2026-09-16

_Patch release published between 4.2.3 and the 5.0.0 major — no dedicated bump commit; contents folded into the releases around it._

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
