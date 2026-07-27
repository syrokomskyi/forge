---
name: skill-create
description: Guides an agent through creating a new forge-compliant skill — determines category, invocation, concerns, dependencies, generates frontmatter, calls forge.port.scaffold, and validates.
invocation: user
category: meta
concerns: document-only
dependsOn: ['grilling', 'writing-great-skills']
languagePolicy: ref(PREFERENCES.md)
---

# skill-create

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Interactive skill that guides an agent through creating a new forge-compliant skill. This is the agent-facing workflow; `forge.port.scaffold --type skill` is the machine-facing OS command that does the actual file generation.

## Process

### 1. Determine skill metadata

Ask the operator (one question at a time):

1. **Name** — kebab-case, matches the directory name.
2. **Description** — one line, ≤ 200 characters.
3. **Category** — `wg`, `shared`, or `meta`.
4. **Invocation** — `user` (operator triggers) or `model` (agent triggers).
5. **Concerns** — `read-only` (no file modifications), `document-only` (modifies `.md` files only), `content-mutation` (modifies content `.md`/`.yaml` but not executable code), or `code-mutation` (modifies `.ts`/`.astro` code).
6. **Dependencies** — list of existing skill names this skill depends on.

### 1.5. Cumulative knowledge analysis (conditional)

If the skill has `concerns: content-mutation | code-mutation` AND `invocation: user`, determine whether to adopt the cumulative knowledge pattern. Skills that run repeatedly and accumulate knowledge across sessions benefit most.

Before creating knowledge files, the agent analyzes the skill's knowledge domain:

1. **What does the skill accumulate?** Classify into one of:
   - **Content violations** — schema mismatches, block type errors, content lint failures (e.g. a site-scanning skill).
   - **Runtime errors** — kernel command failures, git conflicts, build pipeline crashes (e.g. a mission-completion skill).
   - **Workflow decisions** — operator choices on ambiguous steps, routing preferences (e.g. `grilling`).
   - **Operator preferences** — language, style, tooling choices that persist across sessions.

2. **Which L1 structure fits?** The `fix-patterns.md` layer adapts to the knowledge domain:
   - **Proactive fix patterns** — applied _before_ an error occurs (e.g. "remove extraneous prop before validating"). Fits content violations.
   - **Reactive error catalog** — applied _after_ an error occurs (e.g. "when `git am` fails with whitespace error, use `--whitespace=fix`"). Fits runtime errors. Entries carry `confirmations: N` — at N≥3 the skill auto-resolves without asking the operator.
   - **Decision log** — records operator choices for future reuse. Fits workflow decisions.

3. **Which layers are needed?** Not every skill needs all three. `grilling` uses L0+L2 only. A site-scanning skill with all three layers is a good example. A skill with purely reactive error resolution may use L1+L2 only (no Q&A log).

Present the analysis to the operator. If they confirm, create the knowledge files with header comments matching the chosen structure and add `knowledge:` to the frontmatter. See `writing-great-skills` § Cumulative knowledge pattern for the three-layer reference pattern and mutation contract.

### 2. Scaffold

Run `forge.port.scaffold --name <name> --type skill --category <category>` to generate the SKILL.md skeleton with standardized frontmatter.

### 3. Write the body

Fill the SKILL.md body with the skill's behavioral instructions. Follow the conventions in `writing-great-skills`.

### 4. Validate

Run `forge.skill.validate` to verify the new skill passes all invariants (SKILL-01 through SKILL-13).

### 5. Register

Add the new skill to `packages/forge/src/registry.ts` (ForgeSkillEntry[]).

### 6. Commit

```txt
skill: add <name> to forge

Create new <category> skill <name> — <one-line description>.
```
