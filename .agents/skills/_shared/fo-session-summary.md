# WG Session Summary & Next Steps — Mandatory Closing Block

Reference file for all `fo-*` skills. Every `fo-*` skill MUST end its session by presenting the closing block defined here. This is not optional — it is the mandatory final output before the skill stops.

## Session-end protocol (BLOCKED GATE — NON-NEGOTIABLE)

When the operator says any session-end trigger phrase (e.g. "Завершаем сессию", "End session", "Wrap up", "/session-end"), the agent MUST invoke `fo-session-retro` via the `skill` tool BEFORE producing any closing block or session-end output. The closing block defined below is produced by `fo-session-retro` as part of its report — the agent MUST NOT produce a closing block directly in response to a session-end trigger phrase. See `_shared/fo-pipeline-conventions.md` §Session-end trigger phrases for the full protocol.

**Producing a closing block without first invoking `fo-session-retro` is a CONTRACT VIOLATION.**

## When to emit

The closing block is emitted **once**, at the very end of the skill's execution — after all work is done, after all commits, after any batch summaries. It is the last thing the operator sees.

For orchestrator skills (`fo-idea-i-just-want-to-see-the-result`, `fo-idea-i-just-want-to-see-the-plan`), the closing block replaces any ad-hoc "next step" hints with the structured format below.

For skills that produce batch summaries (`fo-idea-implement`, `fo-idea-plan`, `fo-idea-enhance`, `fo-idea-audit`), the closing block comes **after** the batch summary.

## Language

The closing block MUST use `aiLanguage` (from `PREFERENCES.md`), same as all other operator-facing output. See `_shared/fo-pipeline-conventions.md` §Language policy.

**All labels and headings in the closing block must be translated to `aiLanguage`.** The structural format below uses placeholder labels — replace them with the equivalent in the operator's language. Only slash commands and document identifiers (RFC-XXXX, ADR-XXXX, file paths) stay in their original form.

## Engineering Checkpoint protocol (RFC-0884)

The closing block has two modes. The agent selects the mode based on what the session changed:

- **Lightweight mode** — for sessions that do not change system structure (typo fixes, small refactors, document edits, read-only exploration). Uses a 3-section format.
- **Full mode** — for sessions that change architecture, runtime flow, state machines, persistence models, or public contracts. Uses a 6-section format with an optional Mermaid diagram.

### Mode selection

The agent analyzes the session's changes to determine which mode to use. The decision is based on **what changed in the system**, not on the session's chronology:

- If the session changed any of: architecture, component relationships, runtime flow, state machines, persistence models, public contracts, schemas, invariants, pipeline topology → **full mode**.
- Otherwise → **lightweight mode**.

When in doubt, use lightweight mode. A full checkpoint for a session that made no structural changes adds noise without value.

### Diagram selection rules

When using **full mode**, the agent MUST analyze the session's changes to determine if a Mermaid diagram is warranted.

| Change type | Diagram type | When to use |
| --- | --- | --- |
| Architecture / component relationships | `flowchart` | Components, modules, packages, and their dependencies changed |
| Runtime interaction / request flow | `sequenceDiagram` | New or changed runtime interaction between components, services, or external systems |
| Lifecycle / state machine | `stateDiagram-v2` | State transitions, mission lifecycle, release states, or protocol states changed |
| Entities / persistence model | `erDiagram` | Data models, entity relationships, schema changes, storage contracts |
| Pipeline / dependency chain | `flowchart` | Build pipeline, validation pipeline, deployment pipeline changed |
| Quantitative results (performance, coverage, benchmarks) | markdown table | Measurable data exists that is clearer as a table than prose |
| No structural change | _(none)_ | Session did not change system structure, runtime flow, state, or persistence |

**Diagram rules:**

1. **Do not draw a diagram merely to satisfy the requirement.** If no meaningful visualization is warranted, explicitly state: "No diagram: this session did not change system structure, runtime flow, state transitions, persistence relationships, or other relationships that would be clearer visually."
2. **Diagram shows resulting state, not work chronology.** The diagram depicts the system AFTER changes, not the sequence of edits the agent made.
3. **At most one diagram per closing block.** If multiple structural changes occurred, pick the one that most reduces cognitive load. Additional diagrams may appear in the session file or handoff document.
4. **CURRENT vs SESSION DELTA.** For large systems where the full architecture is too complex, the agent may draw a session-delta diagram (only the changed subgraph) instead of the full current-system diagram. If a delta diagram is used, label it as "session delta" and reference the full system context.
5. **Mermaid syntax only.** Diagrams use Mermaid text syntax (`flowchart`, `sequenceDiagram`, `stateDiagram-v2`, `erDiagram`) so they are Git-versionable and diffable.
6. **Quantitative charts are markdown tables.** No image rendering infrastructure is added. If measurable data exists (test counts, coverage %, performance ms), present it as a markdown table with a caption.

### Quality test self-check

After composing the Engineering Checkpoint (either mode), the agent performs a self-check:

> "Can another engineer understand the resulting system state from this checkpoint alone, without reading the full session transcript?"

If the answer is no, the agent improves the checkpoint before presenting it. This is a semantic check performed by the agent, not an automated validation.

## Closing block format — Full mode

Use when the session changed architecture, runtime flow, state machines, persistence models, or public contracts.

```
---

**<Completed label in aiLanguage>**

<1–3 sentences: what was implemented — concretely, with document ids, commit count, review verdict. No filler.>

**<System Delta label in aiLanguage>**

<Changed public contracts, schemas, APIs, state machines, invariants, persistence models, file surfaces. Grouped by category. Each item links to the source file or commit.>

**<Resulting Architecture label in aiLanguage>**

<Mermaid diagram of the system state AFTER changes — only when it reduces cognitive load vs text. See diagram selection rules. If no diagram is warranted, state: "No diagram: this session did not change system structure, runtime flow, state transitions, persistence relationships, or other relationships that would be clearer visually.">

**<Verification label in aiLanguage>**

<Tests executed, type checking, build status, relevant deterministic/recovery/integration checks, important observed results. Each claim links to evidence: test file:line, command output, or commit.>

**<Remaining Issues label in aiLanguage>**

<Known limitations, unverified assumptions, open questions, technical debt introduced. Be honest — this is the uncertainty map.>

**<Next Step label in aiLanguage>**

- `/fo-idea-audit RFC-XXXX` — <one line in aiLanguage: why>
- `/fo-idea-enhance RFC-XXXX` — <one line in aiLanguage: why>
```

## Closing block format — Lightweight mode

Use for sessions that do not change system structure (typo fixes, small refactors, document edits, read-only exploration).

```
---

**<Completed label in aiLanguage>**

<1–3 sentences: what was done.>

**<Verification label in aiLanguage>**

<Tests/typecheck/build status — one line.>

**<Next Step label in aiLanguage>**

- `/fo-idea-status` — <one line in aiLanguage: why>
```

### Rules

1. **Completed** — 1–3 concise sentences in `aiLanguage`. State what was done: document ids, commit count, review verdict, key outcomes. No filler, no repetition of the batch summary — the summary is the _essence_.
2. **System Delta** (full mode only) — changed public contracts, schemas, APIs, state machines, invariants, persistence models, file surfaces. Grouped by category. Each item links to the source file or commit.
3. **Resulting Architecture** (full mode only) — optional Mermaid diagram of the system state AFTER changes. Follow the diagram selection rules. If no diagram is warranted, state explicitly.
4. **Verification** — tests executed, type checking, build status, relevant checks. Each claim links to evidence. In lightweight mode, this is one line.
5. **Remaining Issues** (full mode only) — known limitations, unverified assumptions, open questions, technical debt introduced.
6. **Next Step** — a bulleted list of 1–3 items. Each item is a copy-pasteable slash-command invocation followed by a short `aiLanguage` explanation of why the operator might want to run it.
7. **Only relevant commands** — list only skills that are genuinely applicable as the next step given the current state. Do not list commands that were already completed or that do not apply.
8. **Copy-pasteable** — the slash command must be the exact invocation string the operator can paste into chat. Include the document id if known.
9. **No more than 3 items** — the operator should not be overwhelmed. Pick the most relevant next steps.
10. **Translate labels** — the section headings must be in `aiLanguage`, not English. Only slash commands and identifiers stay untranslated.

### Examples

**After `fo-idea-create-rfc` completes (lightweight mode, aiLanguage = ru):**

```
---

**Сводка**

Создан драфт RFC-0380 «Standardize kernel execution reports» (status: draft, 1 коммит). `rfc.validate` проходит без нарушений. Документ ожидает архитектурного ревью.

**Проверка**

`rfc.validate` — 0 нарушений.

**Дальнейшие шаги**

- `/fo-idea-audit RFC-0380` — семантический аудит RFC перед энхансментом
- `/fo-idea-i-just-want-to-see-the-result RFC-0380` — полный пайплайн до реализации
```

**After `fo-idea-implement` completes (full mode, aiLanguage = en):**

```
---

**Completed**

RFC-0377 implemented: 4 plan steps, 3 commits, scoped build — pass. Review: approved (0 findings). Status: implemented (2026-07-13).

**System Delta**

- **Schemas**: `SessionFrontmatter` extended with `systemDelta`, `diagrams`, `evidence`, `remainingIssues`, `checkpoint` optional fields (`packages/forge/os/session/types.ts:100-117`)
- **Validation**: SES-06 warning rule added to `session.validate` (`packages/forge/os/session/handlers/validate.ts:166-186`)
- **Skills**: `fo-session-summary.md` restructured with lightweight and full checkpoint modes

**Resulting Architecture**

No diagram: this session changed types and skill markdown only, not system structure, runtime flow, state transitions, or persistence relationships.

**Verification**

- `pnpm --filter @warpgogol/forge run build:check` — pass
- `rfc.validate --id RFC-0377` — 0 violations
- `forge.skill.validate` — 0 violations

**Remaining Issues**

None. All acceptance criteria met.

**Next steps**

- `/fo-idea-status` — overview of current RFC/ADR statuses
```

**After `fo-review` completes (lightweight mode, aiLanguage = ru):**

```
---

**Сводка**

Ревью кода завершено: вердикт needs-revision, 3 замечания (Axis B: DNA-23 нарушение, Axis D: legacy путь, Axis E: нет Compass-разметки). Отчёт сохранён в docs/reviews/code/packages-werkstatt-site/.

**Проверка**

Ревью завершено, замечания задокументированы.

**Дальнейшие шаги**

- `/fo-fix` — применить исправления по замечаниям ревью
```

## Mandatory for new skills

Any new `fo-*` skill created via `skill-create` or any other method MUST include a reference to this file in its Constraints section:

```
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
```
