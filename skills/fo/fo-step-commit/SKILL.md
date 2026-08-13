---
name: fo-step-commit
description: >-
  Commit agent file changes after each operator request. Stages only files the
  agent changed, in both monorepo and mission workpiece. Callable by other skills
  for intermediate commits.
invocation: model
category: fo
concerns: code-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "commit after request"
  - "auto-commit changes"
  - "step commit"
---

# Step Commit

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Commit file changes after every standalone operator request that produces file changes. This skill runs autonomously — the agent invokes it before sending its response to the operator, without explicit instruction.

## When this skill runs

- **After every standalone operator request** (default behavior): the agent runs this skill before sending its response to the operator, if any files were changed during the request. "Standalone" means the operator's message is not part of a skill pipeline (e.g. not inside another multi-step skill).
- **Called by other skills**: other skills MAY invoke this skill for intermediate commits during multi-step pipelines. During pipeline execution, only the parent skill's explicit invocations fire — the default "after every request" behavior is suppressed to avoid conflicting with the pipeline's own commit discipline.

## Behavior

After every standalone operator request that produces file changes, perform the following:

1. **Detect changed files in ALL trees.** Run `bash scripts/check-clean-trees.sh` from the repo root. This checks the werkstatt monorepo, all active mission workpieces, and all Sternsystem cache clones. If all trees are clean, skip — no commit. If any tree is dirty, proceed to commit each dirty tree.
2. **Verify diff before staging.** Run `git diff` (not just `git diff --cached`) on every file the agent touched in this request, in each dirty tree. Confirm the changes are the agent's own work and not foreign changes from another session. If foreign changes are found, exclude them from staging.
3. **Stage only agent-changed files.** Stage only the files the agent modified in this request. Never use `git add -A` or `git add .` — another agent or session may have unrelated changes in the working tree. Stage files by explicit path: `git add <path1> <path2> ...`.
4. **Form commit message.** Write a conventional commit message (`fix:`, `feat:`, `refactor:`, `docs:`, `chore:`) based on the work performed in this request. The agent determines the type and description from the context of the request.
5. **Commit in monorepo.** Use `pnpm exec werkstatt run ecosystem.commit --message="<message>"` (NOT raw `git commit`) per RFC-0821. Stage files with `git add <paths>` first, then run ecosystem.commit.
6. **Commit in mission workpiece (if applicable).** If the agent changed files in the active mission workpiece, commit there via `pnpm exec werkstatt run mission.git.commit --mission=<missionId> --message="<message>"` per RFC-0821.
7. **Verify clean trees.** After all commits, run `bash scripts/check-clean-trees.sh` again. If any tree is still dirty, report to the operator.

## What this skill does NOT do

- Does not push to remotes (commits are local).
- Does not run `git status` after commit or report to the operator.
- Does not create empty commits (no changes = no commit).
- Does not stage files the agent did not change in this request.

## Opt-out

The operator can skip the auto-commit for a specific request by saying "не коммить", "don't commit", or similar. The skill MUST respect explicit operator instructions to skip committing.

## Failure modes

- **No changes**: skill detects clean working tree (via check-clean-trees.sh) and skips — no error, no commit.
- **Workpiece not found**: if no active mission workpiece exists, skip workpiece commit. Monorepo commit still proceeds.
- **Workpiece commit fails**: if the workpiece commit fails (e.g. dirty tree from another agent), the skill does not block the monorepo commit. The agent reports the failure to the operator.
- **Post-commit verification**: after committing, re-run `check-clean-trees.sh`. If trees are still dirty, the agent MUST report the remaining dirty files to the operator before sending its response.
