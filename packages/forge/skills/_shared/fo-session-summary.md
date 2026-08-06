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

## Closing block format

```
---

**<Summary label in aiLanguage>**

<1–3 sentences in aiLanguage: what was done in this session — concretely, with document ids, commit count, review verdict. No filler.>

**<Next steps label in aiLanguage>**

- `/fo-idea-audit RFC-XXXX` — <one line in aiLanguage: why>
- `/fo-idea-enhance RFC-XXXX` — <one line in aiLanguage: why>
- `/fo-idea-implement RFC-XXXX` — <one line in aiLanguage: why>
```

### Rules

1. **Summary** — 1–3 concise sentences in `aiLanguage`. State what was done: document ids, commit count, review verdict, key outcomes. No filler, no repetition of the batch summary — the summary is the _essence_.
2. **Next steps** — a bulleted list of 1–3 items. Each item is a copy-pasteable slash-command invocation followed by a short `aiLanguage` explanation of why the operator might want to run it.
3. **Only relevant commands** — list only skills that are genuinely applicable as the next step given the current state. Do not list commands that were already completed or that do not apply. If the skill is terminal (e.g. `fo-idea-status` is read-only), list 0–1 relevant follow-up commands.
4. **Copy-pasteable** — the slash command must be the exact invocation string the operator can paste into chat. Include the document id if known.
5. **No more than 3 items** — the operator should not be overwhelmed. Pick the most relevant next steps.
6. **Translate labels** — the section headings ("Summary", "Next steps") must be in `aiLanguage`, not English. Only slash commands and identifiers stay untranslated.

### Examples

**After `fo-idea-create-rfc` completes (aiLanguage = ru):**

```
---

**Сводка**

Создан драфт RFC-0380 «Standardize kernel execution reports» (status: draft, 1 коммит). `rfc.validate` проходит без нарушений. Документ ожидает архитектурного ревью.

**Дальнейшие шаги**

- `/fo-idea-audit RFC-0380` — семантический аудит RFC перед энхансментом
- `/fo-idea-i-just-want-to-see-the-result RFC-0380` — полный пайплайн до реализации
```

**After `fo-idea-implement` completes (aiLanguage = en):**

```
---

**Summary**

RFC-0377 implemented: 4 plan steps, 3 commits, scoped build — pass. Review: approved (0 findings). Status: implemented (2026-07-13).

**Next steps**

- `/fo-idea-status` — overview of current RFC/ADR statuses
```

**After `fo-review` completes (aiLanguage = ru):**

```
---

**Сводка**

Ревью кода завершено: вердикт needs-revision, 3 замечания (Axis B: DNA-23 нарушение, Axis D: legacy путь, Axis E: нет Compass-разметки). Отчёт сохранён в docs/reviews/code/packages-os-site-kernel-checks/.

**Дальнейшие шаги**

- `/fo-fix` — применить исправления по замечаниям ревью
```

## Mandatory for new skills

Any new `fo-*` skill created via `skill-create` or any other method MUST include a reference to this file in its Constraints section:

```
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
```
