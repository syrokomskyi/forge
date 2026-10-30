# Learned Principles (L2)

Concrete principles distilled from past grilling sessions. Each principle has a condition and a recommended answer. The skill checks these before asking the operator.

<!-- Entries are appended by the skill after meta-analysis and operator approval. -->
<!-- Format:
## <principle title>
- **Condition:** <when this applies>
- **Recommended answer:** <what to recommend>
- **confirmations:** <N>
- **Added:** <date>
-->

## Generalize, compute, delete unused, project from one model
- **Condition:** When extending the workshop with a capability that overlaps an existing mechanism, needs per-language/per-locale content, or surfaces in more than one output (HTML, markdown, llms, agent API, JSON-LD, print).
- **Recommended answer:** Generalize the existing mechanism instead of adding a parallel one; compute everything computable (automatic fallbacks by stable ids) rather than demanding formulas or duplicated text in thin sites; delete a superseded mechanism that has no adopters without a compatibility layer; keep every projection derived from one resolved model under a package-fixed policy with a parity check.
- **confirmations:** 1
- **Added:** 2026-10-30
- **Origin:** RFC-1444 grilling — operator chose the recommended generalizing option on all 12 questions (section languages superseding RFC-1436 companion, routed-locale auto-fallback, partial non-routed trees, one SectionLanguages model for all projections).
