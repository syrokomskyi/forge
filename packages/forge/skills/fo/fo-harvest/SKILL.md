---
name: fo-harvest
description: Systematic self-growth loop — scan the whole project for forge-worthy patterns, grill the operator on portability, and port accepted candidates via port-to-forge / port.scaffold.
category: fo
invocation: user
concerns: code-mutation
dependsOn:
  - my-preferences
  - grilling
languagePolicy: ref(PREFERENCES.md)
triggers: ["harvest portable patterns from code", "extract reusable code pattern to forge", "port this pattern to forge"]
---

# fo-harvest

The systematic self-growth loop for forge. Discover patterns proven in real project work that deserve to be canonicalized into `packages/forge`, grill the operator on portability per candidate, and port accepted candidates through the existing `port-to-forge` skill and `port.scaffold` command.

## When to invoke

- After completing a significant feature, refactor, or bug fix session — the operator wants to check if any patterns emerged that belong in forge.
- When the operator suspects project-local conventions have matured enough to become portable.
- As a periodic sweep (operator-invoked, never automatic).

## Process

### 1. Read preferences

Read `PREFERENCES.md` at the repository root. Use `aiLanguage` for all communication.

### 2. Full project scan

Scan the project for harvest candidates:

- `.agents/skills/` — skills that were created or significantly modified during project work
- Command modules — commands that could be generalized beyond the current project
- `AGENTS.md` deltas — new rules or conventions that other projects could benefit from
- Recurring code patterns — abstractions, utilities, or patterns that appear in 2+ places and could be extracted

Build a candidate table:

| Candidate | Location | Portability         | Reason                  |
| --------- | -------- | ------------------- | ----------------------- |
| ...       | ...      | High / Medium / Low | Why it belongs in forge |

### 3. Grill per candidate

For each candidate, grill the operator:

- Is this pattern project-specific or genuinely portable?
- Does forge already have an equivalent? If so, should the existing one be enhanced instead?
- What is the minimal extraction that preserves the pattern without project-specific coupling?
- Does porting this require a new RFC, or can it go through `port.scaffold` directly?

Only proceed with candidates the operator explicitly accepts. Do not port anything without explicit acceptance.

### 4. Port accepted candidates

For each accepted candidate:

1. Run `port.scaffold` to create the skeleton in `packages/forge/`.
2. Implement the ported logic — inline trivial code, invert dependencies for non-trivial cases.
3. Run `port.validate` to verify compliance with forge contracts.
4. Update `FORGE_SKILLS` registry if a new skill was created.
5. Run `skill.validate` to verify skill frontmatter.

### 5. Registry + docs update

After all accepted candidates are ported:

- Update `packages/forge/AGENTS.md` if new commands or skills were added.
- Update root `AGENTS.md` if the skill surface changed.
- Commit with reference to this harvest run.

## Constraints

- **Operator-invoked only.** Never auto-run harvest on a schedule.
- **One port per candidate.** Do not batch multiple patterns into one port — each candidate gets its own `port.scaffold` call and its own commit.
- **No hand-copying.** All porting goes through `port-to-forge` / `port.scaffold`. Do not manually copy files into `packages/forge/`.
- **Grilling is mandatory.** Every candidate must pass the grilling step before porting. No silent ports.
- **Forward-only.** If a pattern replaces an existing forge skill or command, the old one is removed in the same change — no parallel implementations.
