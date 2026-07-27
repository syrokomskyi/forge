---
name: fo-qa
description: Interactive QA session where the operator reports bugs conversationally and the agent files durable GitHub issues. Explores codebase for domain language.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggers: ["I found a bug", "file a GitHub issue for this bug", "report a bug conversationally", "interactive QA session"]
---

# fo-qa

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Run an interactive QA session. The operator describes problems they're encountering. You clarify, explore the codebase for context, and file GitHub issues that are durable, user-focused, and use the project's domain language.

## Process

### For each issue the operator raises

#### 1. Listen and lightly clarify

Let the operator describe the problem in their own words. Ask **at most 2-3 short clarifying questions** focused on:

- What they expected vs what actually happened
- Steps to reproduce (if not obvious)
- Whether it's consistent or intermittent

Do NOT over-interview. If the description is clear enough to file, move on.

#### 2. Explore the codebase in the background

While talking to the operator, explore the relevant area. The goal is NOT to find a fix — it's to:

- Learn the domain language used in that area (check `UBIQUITOUS_LANGUAGE.md` or `CONTEXT.md`)
- Understand what the feature is supposed to do
- Identify the user-facing behavior boundary

This context helps write a better issue — but the issue itself should NOT reference specific files, line numbers, or internal implementation details.

#### 3. Assess scope: single issue or breakdown?

Before filing, decide whether this is a **single issue** or needs to be **broken down** into multiple issues.

Break down when:

- The fix spans multiple independent areas
- There are clearly separable concerns that different people could work on in parallel
- The operator describes something with multiple distinct failure modes

Keep as a single issue when:

- It's one behavior that's wrong in one place
- The symptoms are all caused by the same root behavior

#### 4. File the GitHub issue(s)

Create issues with `gh issue create`. Do NOT ask the operator to review first — just file and share URLs.

Issues must be **durable** — they should still make sense after major refactors. Write from the user's perspective.

##### Single issue template

```
## What happened

[Describe the actual behavior the user experienced, in plain language]

## What I expected

[Describe the expected behavior]

## Steps to reproduce

1. [Concrete, numbered steps a developer can follow]
2. [Use domain terms from the codebase, not internal module names]
3. [Include relevant inputs, flags, or configuration]

## Additional context

[Any extra observations from the user or from codebase exploration that help frame the issue — use domain language but don't cite files]
```

##### Breakdown template (per sub-issue)

```
## Parent issue

#<parent-issue-number> or "Reported during QA session"

## What's wrong

[Describe this specific behavior problem — just this slice]

## What I expected

[Expected behavior for this specific slice]

## Steps to reproduce

1. [Steps specific to THIS issue]

## Blocked by

- #<issue-number> (if this issue can't be fixed until another is resolved)

Or "None — can start immediately" if no blockers.

## Additional context

[Any extra observations relevant to this slice]
```

When creating a breakdown:

- **Prefer many thin issues over few thick ones** — each independently fixable and verifiable.
- **Mark blocking relationships honestly.**
- **Create issues in dependency order** so you can reference real issue numbers.
- **Maximize parallelism.**

##### Rules for all issue bodies

- **No file paths or line numbers** — these go stale.
- **Use the project's domain language** (check `UBIQUITOUS_LANGUAGE.md` if it exists).
- **Describe behaviors, not code** — "the sync service fails to apply the patch" not "applyPatch() throws on line 42."
- **Reproduction steps are mandatory** — if you can't determine them, ask the operator.
- **Keep it concise** — a developer should be able to read the issue in 30 seconds.

After filing, print all issue URLs (with blocking relationships summarized) and ask: "Next issue, or are we done?"

#### 5. Continue the session

Keep going until the operator says they're done. Each issue is independent — don't batch them.

## Constraints

- **No file paths or line numbers in issues.** They go stale. Use domain language.
- **Do not ask the operator to review before filing.** File and share URLs.
- **Reproduction steps are mandatory.** If you can't determine them, ask.
- **Commit only your own files.** This skill files issues, not commits. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
