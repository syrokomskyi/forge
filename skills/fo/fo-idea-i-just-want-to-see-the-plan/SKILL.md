---
name: fo-idea-i-just-want-to-see-the-plan
description: Run the idea-to-plan pipeline (idea, audit, enhance, plan) in a single invocation, then stop. Accepts a raw idea or an existing RFC id. Use when the operator wants a plan, not implementation.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'fo-idea-i-just-want-to-see-the-result']
languagePolicy: ref(PREFERENCES.md)
triggers: ["I just want to see the plan", "plan this feature without implementing", "run idea to plan pipeline"]
---

# Idea to Plan — Just Want to See the Plan

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

See `_shared/fo-pipeline-conventions.md` §Language policy.

## What this skill does

Thin wrapper around `fo-idea-i-just-want-to-see-the-result`. Invokes the orchestrator with `stopAfter: plan`, which runs steps 0–3 only (idea → audit → enhance → plan). Step 4 (implement, which includes review and fix) is not run.

## ADR documents

ADRs skip audit, enhance, and plan. The orchestrator stops after step 0 (idea creation) with the message: "ADR does not require a plan. Run `/fo-idea-implement` to implement."

## After the orchestrator stops

Present the orchestrator's summary, then add this next-step hint:

Run `/fo-idea-implement` to execute the plan (which now includes review and fix), or `/fo-idea-i-just-want-to-see-the-result` to run the remaining pipeline automatically.

**Stop.** The operator asked to "just see the plan" — the plan and the hint above are the result.

## Constraints

- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
