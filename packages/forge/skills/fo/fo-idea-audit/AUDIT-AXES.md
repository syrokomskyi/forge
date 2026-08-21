# Audit Axes

Load this file when running step 4 of `fo-idea-audit`. For each axis, check every item. An item either **passes**, **fails** (specific finding with evidence), or is **not applicable** (state why). Skip N/A items silently — do not pad the report.

## Axis A — Structural completeness

Beyond V-13 (required sections exist) and V-14 (≥3 acceptance items), check that each section contains real content, not template placeholders or empty HTML comments:

- **Decision** is a single decision in present tense ("The kernel gains…"), not a wishlist or "we should".
- **CLI surface** shows exact `pnpm exec werkstatt run …` invocations with flags and scope.
- **TypeScript contracts** are minimal type signatures, not full implementations.
- **File system responsibilities** table names concrete paths the RFC touches.
- **Output format** documents the `--json` shape.
- **Failure modes** specifies exit codes and warn-vs-fail behavior.
- **Rollout** describes default behavior, adoption path for existing apps, and new-app compliance.
- **Alternatives considered** is honest — at least one real alternative with a rejection reason.
- **Risks** includes agent misinterpretation risk and false-positive rate for validators.
- **Acceptance criteria** items are checkable (can an agent or human verify each one?) and sufficient (do they cover the decision's full scope?).
- **Implementation notes for agents** are explicit behavioral rules, not vague guidance.

## Axis B — DNA alignment

- Each entry in `satisfies[]` is a real DNA invariant in `docs/architecture-dna.md`, and the RFC body explains **how** it enforces, protects, or extends that invariant — not just that it's "related".
- If the RFC establishes a new DNA invariant (body says "DNA-N established by this RFC"), the audit confirms `docs/architecture-dna.md` will need a new `## DNA-N` entry and the RFC's `satisfies[]` includes it.
- The RFC does not silently conflict with any existing DNA invariant. If it changes a DNA invariant, it must `supersede` the establishing RFC — not amend it.
- `related[]` DNA references are relevant and not decorative.

## Axis C — Ecosystem fit

- **Package boundaries**: imports flow `apps/* → packages/*` and `services/* → packages/*`, never `apps/* → apps/*` or `apps/* → services/*` (DNA-1). If the RFC proposes a new package, it belongs in `packages/*`.
- **Pipeline placement**: the RFC names the correct pipeline for each new check — `build.prepare`, `build.check`, `sites-check`, `sites-check-postbuild` — and the choice is justified (blocking vs. advisory).
- **Compass sync**: if the RFC changes repository-wide requirements, shared package contracts, or app-package relationships, it identifies which `docs/*.xml` files need synchronization (root AGENTS.md Compass document duties).
- **AGENTS.md updates**: the RFC identifies which `AGENTS.md` files need rule updates (root, `apps/`, `packages/`, `services/`, or site-specific).
- **Cosmic naming**: if the RFC touches manifests or component/section/page contracts, it addresses the three-way alignment (manifest `cosmicName` ↔ `PLANET_IMPORT_PATHS`/`MOON_IMPORT_PATHS` ↔ `system.md` pins).
- **Command lifecycle**: `commands.proposed/added/changed/removed` buckets are internally consistent — proposed commands that the RFC introduces will land in `added` upon implementation; changed commands are existing registered commands; removed commands are explicitly deprecated.

## Axis D — Forward-only compliance

This ecosystem is forward-only — no backward compatibility layers, no expand-then-contract migrations. Check:

- The RFC does not propose a compatibility shim, bridge, or dual-path that keeps legacy behavior alive alongside the new one.
- Deprecation means removal in the same RFC wave, not an indefinite grace period.
- If the RFC amends another RFC, it changes the amended RFC's contract directly — it does not add a parallel interpretation.
- Legacy code paths are deleted, not maintained behind a flag.

## Axis E — Agent-facing policy

- **Status gate**: the RFC does not contain self-authorizing language ("may proceed while draft", "implementation can start before acceptance"). Draft RFCs cannot grant implementation permission.
- **Implementation notes** reference the correct governance rules: RFC-0224 (accepted→implemented transition), RFC-0230 (if touching agent surface), RFC-0334 (supersede escalation on invariant conflict), RFC-0330 (verification evidence for probe-bearing RFCs).
- **Anti-fabrication**: if the RFC's acceptance criteria include content authoring (prose, business records, claims), the criteria distinguish between code changes an agent can make and content that requires human authoring. The RFC must not claim content will be "auto-generated" when it requires human authoring.
- **Storage policy**: if the RFC touches persistence, it does not introduce cookies (`document.cookie`, `Set-Cookie`). Client-side persistence is `localStorage` only; server-side is `unstorage`.

## Axis F — Pragmatism

- **Minimal command surface**: each proposed command earns its existence — no command that could be a flag on an existing command, no command that duplicates an existing command's scope.
- **Lean contracts**: TypeScript types are the minimum needed to understand the shape — no speculative generality, no unused optional fields, no abstraction for needs the RFC doesn't have.
- **Existing patterns**: the RFC checks whether an existing command, schema, or pattern can be extended before proposing a new one. If a new one is proposed, the alternatives section explains why extension was insufficient.
- **Scope discipline**: `appsImpacted` and `packagesImpacted` list only what's actually impacted. `nonGoals` are explicit and meaningful, not boilerplate.

## Axis G — Blind spots

- **Performance**: build-time commands specify their cost (file scan count, regex complexity, I/O patterns). A command that scans all `apps/**` on every `build.check` is a bottleneck.
- **False positives**: validators estimate their false-positive rate and describe how to suppress noise during migration.
- **Edge cases**: the RFC considers empty states (new app with no content, package with no manifests), concurrent execution (two builds, two agents), and interrupted operations (crash mid-write).
- **Migration path**: existing apps' path to compliance is documented — do they pass without changes, or is there a documented migration window?
- **Security/privacy**: if the RFC touches user data, PII, or external services, it addresses GDPR/privacy implications and secret management (no hardcoded keys, env vars documented in `.env.example` per DNA-40).
