---
name: fo-triage
description: Move issues and external PRs through a triage state machine — categorize, verify, grill, write agent-ready briefs. Use for incoming bug reports and feature requests.
invocation: user
category: fo
concerns: document-only
dependsOn: ['my-preferences', 'grilling']
languagePolicy: ref(PREFERENCES.md)
triggers: ["triage this issue", "categorize incoming bug report", "triage external pull request", "process feature request"]
---

# fo-triage

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Move incoming issues and external PRs through a triage state machine. For each issue: categorize, verify, grill if needed, and write an agent-ready brief that a fresh agent can pick up with no human context.

## State machine

Five canonical roles, each mapped to a label:

| Role              | Label           | Meaning                                                  |
| ----------------- | --------------- | -------------------------------------------------------- |
| `needs-triage`    | needs-triage    | Maintainer must evaluate                                 |
| `needs-info`      | needs-info      | Waiting on reporter                                      |
| `ready-for-agent` | ready-for-agent | Fully specified, agent can pick up with no human context |
| `ready-for-human` | ready-for-human | Needs human implementation                               |
| `wontfix`         | wontfix         | Will not be actioned                                     |

The issue tracker and triage label vocabulary should have been configured. If not, ask the operator which tracker and labels to use.

## Process

### 1. Gather the queue

Collect issues that need triage. Sources:

- **GitHub** — `gh issue list --label needs-triage`
- **GitLab** — `glab issue list --label needs-triage`
- **Local markdown** — scan `.scratch/` or the configured local tracker
- **External PRs** — if the operator enabled PRs as a request surface, include external PRs in the queue. Collaborators' in-flight PRs are left alone.

### 2. Triage each issue

For each issue, work through these steps:

#### 2a. Categorize

Classify as `bug` or `enhancement`:

- **Bug** — the system does something it shouldn't, or doesn't do something it should.
- **Enhancement** — a request for new functionality or improved behavior.

#### 2b. Verify

For bugs:

- Can you reproduce it from the description?
- Is there a clear expected vs actual behavior?
- Are there steps to reproduce?

If the issue lacks enough info to verify, move to `needs-info` and ask the reporter for specifics.

#### 2c. Grill (if needed)

If the issue is an enhancement that's vague or under-specified, run the `grilling` skill to stress-test the request. Ask one question at a time. Look up facts in the codebase rather than asking the reporter.

#### 2d. Write the brief

If the issue is fully specified, write an agent-ready brief and move to `ready-for-agent`. The brief must include:

- **What to build** — the end-to-end behaviour, from the user's perspective.
- **Acceptance criteria** — checkable, unambiguous.
- **Domain language** — use the project's ubiquitous language, not internal module names.
- **No file paths or line numbers** — they go stale.

### 3. Update labels

Apply the appropriate label to each issue after triaging it. Remove `needs-triage` and add the destination label.

### 4. Report

After triaging all issues in the queue, present a summary:

| Issue | Category    | Result          | Label applied   |
| ----- | ----------- | --------------- | --------------- |
| #42   | bug         | ready-for-agent | ready-for-agent |
| #43   | enhancement | needs-info      | needs-info      |
| #44   | bug         | wontfix         | wontfix         |

## Constraints

- **Triage is only for issues you didn't create.** Tickets produced by other skills are already agent-ready — don't re-triage them.
- **No file paths or line numbers in briefs.** They go stale. Use domain language.
- **One question at a time during grilling.** See the `grilling` skill.
- **Commit only your own files.** This skill modifies issue labels, not source files. See `_shared/fo-pipeline-conventions.md` §Commit discipline.
- **Session summary.** End every session with the closing block defined in `_shared/fo-session-summary.md`.
