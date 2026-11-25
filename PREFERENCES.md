---
aiLanguage: en
documentationLanguage: en
register: business
formOfAddress: formal
---

# Operator Preferences

This file stores operator-level preferences that AI agents read at the start of a session.

## Current preferences

- `aiLanguage` — en — AI uses this language for all communication with the operator.
- `documentationLanguage` — en — generated documentation uses this language.
- `register` — business — communication register (business or creative).
- `formOfAddress` — formal — form of address (formal or informal).

## Plan confirmation vs implementation command (NON-NEGOTIABLE)

Confirming a plan or design during grilling/discussion means the operator agrees with the approach — it is NOT a command to start implementation. The agent MUST wait for an explicit implementation command ("implement", "go ahead", "реализуй", "начинай") before writing any code beyond the RFC/ADR document itself.

- **RFC creation** → agent creates the RFC file in `draft` status. No code changes.
- **Plan confirmation** → agent stops. No status change, no implementation, no todo list items moved to `in_progress`.
- **Implementation command** → only now does the agent begin coding, register commands, write tests, etc.

If the agent is unsure whether the operator's message is a confirmation or a command to implement, the agent MUST ask for clarification before proceeding.

## Skill invocation tracking

When a skill is invoked (e.g. `fo-idea-i-just-want-to-see-the-result`), the agent MUST complete the full skill pipeline. Stopping halfway (e.g. after `fo-idea-create-rfc` when the operator asked for the full result) is a protocol violation. If a step fails, the agent reports the failure and asks for guidance — it does not silently skip remaining steps.

## Commit granularity

One logical fix = one commit, regardless of how many iterations were needed to produce it. Do not split a single logical change into multiple commits just because multiple edit rounds were needed. Conversely, do not combine unrelated changes into a single commit.

## Session-end protocol

When the operator signals session end (phrases like "End session", "Wrap up", "Завершаем сессию", "/session-end"), the agent MUST:

1. Verify clean working trees — run: `bash scripts/check-clean-trees.sh`
2. Commit session-attributed changes unconditionally (never ask); leave unattributed files untouched and report them
3. Invoke the `fo-session-retro` skill via the skill tool
4. The retro skill's report IS the session-end output — do not produce a separate closing summary

This protocol is enforced by the `hooks/pre-user-prompt.sh` hook as a blocked gate.

