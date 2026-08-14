<!-- knowledge-layer: L0 -->

# Q&A Log (L0)

Append-only log of questions asked and answers given during grilling sessions. Used for meta-analysis to distill recurring decision patterns.

### K-0001: Entry format for L0/L1/L2 knowledge records

```knowledge-entry
id: K-0001
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Entry format for L0/L1/L2 knowledge records?
- **Answer:** Markdown files with per-entry YAML metadata blocks (human-readable, grep-able, parseable); soft migration for existing freeform entries.

### K-0002: How to define and enforce layer token budgets

```knowledge-entry
id: K-0002
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** How to define and enforce layer token budgets?
- **Answer:** Hard defaults in forge (L2 hot ~4KB, L1 warm ~8KB, L0 cold unbudgeted), optional override in forge.yaml bindings; warning on exceed, not error.

### K-0003: Where does AI distillation L0→L1/L2 live

```knowledge-entry
id: K-0003
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Where does AI distillation L0→L1/L2 live?
- **Answer:** New skill fo-knowledge-distill alongside deterministic forge.skill.knowledge.compact command; code mutates metadata, agent distills meaning.

### K-0004: Should .agents/memory/ be versioned in git

```knowledge-entry
id: K-0004
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — forge knowledge lifecycle RFC series (RFC-1..5)
- **Question:** Should .agents/memory/ be versioned in git?
- **Answer:** Hybrid — MEMORY.md (curated) versioned, daily logs git-ignored.

### K-0005: Schema extension before logic that depends on new fields

```knowledge-entry
id: K-0005
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (cross-skill knowledge promotion)
- **Question:** RFC proposes a new metadata field (promotedFrom) but the underlying schema (RFC-0660) doesn't define it. Where should schema extension live in the plan?
- **Answer:** Schema extension must be a separate step before any logic that creates or reads the field. Zod safeParse silently strips unknown fields; the serializer uses a fixed FIELD_ORDER array. Without extending both, the field is lost on parse and never written on serialize.

### K-0006: Doctor check status for informational warnings

```knowledge-entry
id: K-0006
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (knowledge-duplicate doctor check)
- **Question:** RFC says "informational warnings, never affects exit status." Should the doctor check use status "pass" or "warn"?
- **Answer:** Use "warn" when duplicates found, "pass" when none. Only "fail" affects exit status. "warn" makes duplicates visible in doctor summary (N warn(s)) and --json output, consistent with RFC-0661 SKILL-21 budget warnings. "pass" always would hide duplicates in the summary.

### K-0007: Validating non-skill knowledge files in doctor

```knowledge-entry
id: K-0007
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (shared knowledge layer validation)
- **Question:** The shared knowledge layer file is not inside a skill directory (no SKILL.md). Existing checks (checkLegacyKnowledgeSections, checkKnowledgeBudgets) and forge.skill.validate (SKILL-19/SKILL-20) discover knowledge files only through the skill registry. How to validate it?
- **Answer:** Add a dedicated checkSharedKnowledgeFile() in doctor.ts that parses the shared file via parseKnowledgeFile and checks SKILL-19 (schema validity) and SKILL-20 (id uniqueness) directly. A skill-wrapper would misrepresent the shared layer as a skill; skipping validation leaves schema violations undetected.

### K-0008: Dogfood criterion when no real duplicates exist

```knowledge-entry
id: K-0008
layer: L0
created: 2026-08-03
status: active
```

- **Context:** 2026-08-03 — grilling RFC-0663 plan (dogfood acceptance criterion)
- **Question:** RFC requires "at least one real duplicate pair promoted end-to-end" but the current monorepo has very few L2 entries across skills. Real duplicates are unlikely. How to handle the dogfood criterion?
- **Answer:** Conditional dogfood: run detection on the monorepo. If duplicates found, promote with operator approval. If none found, the detection pipeline running end-to-end (detection → doctor report → zero duplicates) serves as evidence. Promotion mechanics are verified by unit tests. Creating artificial test duplicates is not natural and would not test the real promotion path.

### K-0054: Agent-run Node 24 bootstrap before repository cutover

```knowledge-entry
id: K-0054
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement after the Node 24 ecosystem audit
- **Question:** May the implementing agent install and activate Node 24 on the Ubuntu host before changing repository engine enforcement, even though Werkstatt itself must not auto-download or fall back to another runtime?
- **Answer:** Yes. Runtime provisioning is an explicit step-zero environment bootstrap performed by the implementing agent before any repository mutation, not product fallback behavior. The agent re-verifies Node and pnpm under Node 24; if provisioning or verification fails, it stops without changing repository files.

### K-0055: Forge uses a real major boundary for the Node 24-only contract

```knowledge-entry
id: K-0055
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement after the Node 24 ecosystem audit
- **Question:** Which independent Forge version represents removal of Node 20/22 support, and how is it separated from publication?
- **Answer:** Bump `@warpgogol/forge` from `0.28.0` to `1.0.0`, set `forge.syncedVersion` to the same value, and require a standalone Node 24 tarball smoke test. Implementation records the version but does not publish; npm publication remains a separate explicit operator command.

### K-0056: Stage the single-site Node 24 republish through Alt

```knowledge-entry
id: K-0056
layer: L0
created: 2026-08-14
status: active
```

- **Context:** 2026-08-14 — RFC-0854 enhancement, current Sternsystem cutover
- **Question:** May the replaceable single site republish directly to Main, or must it prove the Node 24 build/deploy path through Alt first?
- **Answer:** Require `Alt deploy → Alt smoke pass → Main deploy → Main smoke pass`. Any non-pass stops the transition and blocks RFC completion; the single-site topology does not justify bypassing the available staging proof.
