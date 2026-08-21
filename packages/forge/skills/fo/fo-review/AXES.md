# Review Axes

Load this file when running step 4 of `fo-review`. For each axis, check every item. An item either **passes**, **fails** (specific finding with evidence), or is **not applicable** (state why). Skip N/A items silently — do not pad the report.

## Axis A — Structural correctness

Beyond what the mechanical floor catches:

- **Strict typing** — flag `any`, implicit casts, missing interfaces, untyped parameters, non-exhaustive switch/if chains.
- **No magic numbers or untyped data** — flag literal constants that should be named, enums, or config; flag strings standing in for domain concepts.
- **Minimalism** — flag over-engineered abstractions, speculative generality, duplicated logic, or middle-man modules that can be simplified.
- **Dead code** — flag unreachable branches, unused exports, commented-out code blocks.
- **Error handling** — flag swallowed errors, bare `catch` blocks without context, missing error types.

## Axis B — DNA alignment

Check the diff against every DNA invariant it touches. The list below is the minimum scan set — if the diff touches a DNA invariant not listed here, check it too.

- **DNA-1** (monorepo boundary) — no `apps/* → apps/*` or `apps/* → services/*` imports.
- **DNA-4** (canonical content) — no hardcoded copy strings or configuration in routes/components that belongs in `src/content/`.
- **DNA-5 / DNA-17** (mirror quintet) — every new `.astro` component/section has colocated `manifest.yaml`, content schema, `.css`, and content `.md`.
- **DNA-6** (kebab-case) — all new filenames use kebab-case.
- **DNA-7** (thin routes) — route files are orchestrators only; no inline `<style>`, hardcoded body copy, or layout logic.
- **DNA-8** (page → section → component → content) — visitor-facing page bodies are composed as ordered section components.
- **DNA-10** (no hardcoded tokens) — CSS uses `--ds-*` custom properties only; no raw `rgba()` or `#hex`.
- **DNA-23** (cosmic naming) — new manifests carry `cosmicName` from the correct closed catalog; three-way alignment (manifest ↔ `PLANET_IMPORT_PATHS` / `MOON_IMPORT_PATHS` ↔ `system.md`).
- **DNA-24** (block-declarative pages) — page entries are frontmatter-only; no markdown bodies.
- **DNA-25** (single buildPage) — routes call `buildPage`; no hand-assembled block composition.
- **DNA-40** (env-example) — new env vars are documented in `.env.example`.
- **DNA-42** (Compass markup) — new authored source files carry `MODULE_CONTRACT` and `CHANGE_SUMMARY`.
- **DNA-51** (Werkstatt primitives) — mutating Werkstatt commands use shared lock/idempotency/atomic-write helpers.

## Axis C — Ecosystem fit

- **Package boundaries**: imports flow `apps/* → packages/*` and `services/* → packages/*`, never `apps/* → apps/*` or `apps/* → services/*`.
- **Pipeline placement**: new checks are placed in the correct pipeline (`build.prepare`, `build.check`, `sites-check`, `sites-check-postbuild`) with justified blocking vs. advisory choice.
- **Compass sync**: if the diff changes repository-wide requirements, shared package contracts, or app-package relationships, the relevant `docs/*.xml` files are updated.
- **AGENTS.md updates**: if the diff introduces new rules or patterns, the relevant `AGENTS.md` files are updated.
- **Cosmic naming**: if the diff touches manifests or component/section/page contracts, the three-way alignment is maintained.
- **Command lifecycle**: new commands are registered in the correct module; changed commands update their metadata; removed commands are explicitly deprecated.

## Axis D — Forward-only compliance

- No compatibility shims, bridges, or dual-paths that keep legacy behavior alive.
- Deprecation means removal in the same change, not an indefinite grace period.
- Legacy code paths are deleted, not maintained behind a flag.
- If the diff amends an existing contract, it changes the contract directly — no parallel interpretation.

## Axis E — Agent-facing clarity

- **Compass scaffolding**: new non-trivial source files carry `MODULE_CONTRACT` and `CHANGE_SUMMARY`; high-risk files carry `@ai-invariant` lines.
- **No ungrounded assertions**: code comments and docstrings reference real functions, types, and files — no invented APIs or phantom parameters.
- **Readable by another agent**: variable names reveal what they hold; function names reveal what they do; no mysterious names.
- **Log-driven development**: logs carry enough context for debugging; no bare `console.log` without context or structure. Prefer the repo's shared logging contracts when they exist.
- **Anti-fabrication**: if the diff includes content claims (prose, business records), the code distinguishes between generated content and human-authored content.

## Axis F — Pragmatism

- **Minimal command surface**: each new command earns its existence — no command that could be a flag on an existing command.
- **Lean contracts**: TypeScript types are the minimum needed — no speculative generality, no unused optional fields.
- **Existing patterns**: the diff checks whether an existing command, schema, or pattern can be extended before introducing a new one.
- **Scope discipline**: the diff touches only what's necessary; no scope creep into unrelated areas.

## Axis G — Blind spots

- **Performance**: new build-time commands specify their cost (file scan count, regex complexity, I/O patterns).
- **False positives**: new validators estimate their false-positive rate and describe suppression during migration.
- **Edge cases**: the diff considers empty states (new app with no content), concurrent execution, and interrupted operations.
- **Migration path**: existing apps' path to compliance is documented.
- **Security / privacy**: if the diff touches user data, PII, or external services, it addresses GDPR/privacy and secret management. No cookies (`document.cookie`, `Set-Cookie`). Client-side persistence is `localStorage` only; server-side is `unstorage`.
