---
name: forge-bootstrap
description: Configure a freshly created forge project — greenfield or transplant — with a barrier-free, creator-facing onboarding experience.
invocation: user
category: meta
concerns: content-mutation
dependsOn: ['my-preferences']
languagePolicy: ref(PREFERENCES.md)
bindings:
  requires: []
  optional: []
knowledge:
  - forge-about.md
  - operator-profile-template.md
  - project-narrative-template.md
  - milestone-gallery/
---

# forge-bootstrap

Interactive skill for configuring a freshly created forge project. Runs after `forge create` (which produces the project skeleton with `forge.yaml`, synced skills, and forge-CLI binding defaults). The operator is a creator, not a programmer. The system hides all complexity — no CLI commands, no guides, no formats, no internal jargon, no educational detours about how the system works internally reach the operator.

## Guardrails

- The skill refuses to run if `forge.yaml` is absent (not a forge project).
- The skill never overwrites forge-CLI binding defaults; it fills only `null` stack bindings.
- The skill never overwrites an existing `PREFERENCES.md` without operator confirmation; it merges language settings if the file already exists.
- The skill is idempotent: re-running it skips non-null bindings and confirms existing settings rather than overwriting them.
- The skill never modifies the transplant source directory.
- The skill never includes CLI commands (e.g. `pnpm exec forge doctor`, `forge --help`) in user-facing report text. The system hides all complexity from the operator.
- The skill never explains ADR, RFC, or governance concepts to the operator during onboarding. The operator discovers these naturally during work.
- The skill never asks the operator if they want to learn about RFCs, ADRs, or how the system works internally. Onboarding leads directly to creating.
- The skill never auto-creates RFCs — only ADRs are auto-created silently (for both greenfield and transplant).
- The skill never skips the auto-doctor step — it runs internally, not as a suggested operator action.
- The skill never skips the silent auto-ADR step — the ADR is created, not suggested, for both greenfield and transplant.
- The skill never copies the `.git` directory directly — git history transfer uses `git format-patch` + `git am` only.
- The skill always transfers untracked and git-ignored files (e.g. `.env`, `.env.local`, secret config files, local certificates, input data, runtime state) from the source project — these are necessary for the project to work immediately after onboarding. The `migrate()` adapter copies all files on disk, not just git-tracked files. Only build artifacts (`node_modules/`, `dist/`, `.next/`, `.cache/`, `.turbo/`), `.git/`, and forge-protected files are excluded.
- The skill always offers the operator an interactive selection of git-ignored files before copying them — the operator chooses which categories to transfer (config, data, runtime-state, cache, other). Config files (`.env`, secrets, certificates) are selected by default and the operator must explicitly opt out. The operator never loses files from their previous project without being asked.
- The skill never collects personal data as a separate interview before the first creation moment — personal data emerges naturally from the creative dialogue.
- `operator-profile.md` is local and private — it is in `.gitignore` and is not committed to the repository. The operator can delete it at any time.
- Gender is optional — the operator may decline to provide it. If declined, the skill uses gender-neutral addressing and notes the absence in `operator-profile.md`.
- Form of address defaults to formal if the operator skips the question.
- The skill never informs the operator about migration, version numbers, or upgrade mechanics — the silent version check in step 0 is invisible to the operator.
- The skill never asks the operator for permission to migrate — if versions differ, migration runs automatically.

## Process

### 0. Silent version check (before language selection)

Before any operator interaction, silently check whether the installed `@warpgogol/forge` version matches the version recorded in `forge.yaml`:

1. Read `forge.yaml` and extract `forge.syncedVersion`. If `forge.yaml` is absent, the skill refuses — no change from existing guardrail.
2. If `forge.syncedVersion` is absent or `null`, treat it as "never synced".
3. Resolve the installed `@warpgogol/forge` version by reading `node_modules/@warpgogol/forge/package.json` (the `version` field). If the file cannot be read (forge not installed yet), skip the version check entirely and proceed to step 1.
4. If `forge.syncedVersion` equals the installed version — skip to step 1 (language selection). No migration needed.
5. If versions differ (or `syncedVersion` is `null`/absent) — silently run `forge upgrade` via CLI. The agent executes the command internally and does not show any output to the operator. The upgrade syncs `.agents/skills/`, adds missing binding defaults, updates `forge.syncedVersion`, and runs `forge.doctor` — all invisibly.
6. If `forge upgrade` fails — log the error to the session log (not shown to the operator), proceed to step 1 with the old configuration. `forge.syncedVersion` is not updated, so the next `forge-bootstrap` invocation will retry.
7. Proceed to step 1 (language selection) regardless of success or failure. The operator sees no text about migration, version numbers, or upgrade mechanics.

### 1. Language selection (first step)

Read `PREFERENCES.md` at the project root. `forge create` writes a placeholder with `aiLanguage: en` and `documentationLanguage: en`.

Ask the operator:

> In which language should the AI communicate with you? (e.g. en, ru, uk, de, es) In which language should project documentation be written? (RFCs, ADRs, READMEs)

Accept free-form answers like "Russian", "русский", "uk" or "English". Prefer IETF BCP 47 language tags when the operator provides them.

Write or merge the values into `PREFERENCES.md`. **All subsequent communication in this skill session uses the operator's chosen `aiLanguage`.**

If `PREFERENCES.md` already has non-default `aiLanguage` set (re-run of the skill), confirm the existing values with the operator instead of asking again. The operator may change them if desired.

### 2. Register selection (new)

Ask the operator one question:

> How would you like to work with the system? In a business register — direct, efficient, by-the-numbers? Or in a creative register — as a creative partner, thinking out loud, with emotional support?

Accept the operator's choice and store it:

- In `PREFERENCES.md` as `register: business` or `register: creative`.
- In `operator-profile.md` under `## Register`.

The register controls whether the extended behavioral layer is included in `AGENTS.md`. Both registers receive the full core behavioral layer. The operator can change the register at any time via live operator feedback.

### 3. Operator name, gender, and form of address (new)

Ask the operator:

> What is your name? (This is how the system will address you.)

Then ask:

> What is your gender? (This helps with correct grammar in some languages. You can skip this if you prefer.)

If the operator declines to provide gender, use gender-neutral addressing and note the absence in `operator-profile.md` under `## Personal`.

Then ask about the form of address:

> Do you prefer informal or formal address? In some languages this means saying "you" in a familiar way (e.g. "ty" in Russian/Ukrainian, "du" in German) versus a more formal way (e.g. "vy" in Russian/Ukrainian, "Sie" in German). If you're not sure, formal is the safe default.

Accept the operator's choice and store it:

- In `PREFERENCES.md` as `formOfAddress: formal` or `formOfAddress: informal`.
- In `operator-profile.md` under `## Register`.

If the operator skips the question, default to `formOfAddress: formal`. The preference applies to all agent-generated text: chat messages, reports, suggestions, and skill output. The operator can change it at any time by editing `PREFERENCES.md`.

Store the operator's name, gender (or absence), and form of address in `operator-profile.md` under `## Personal` and `## Register`. These are the only personal data collected before the first creation moment.

### 4. Verify forge project

Check that `forge.yaml` exists in the project root. If absent, refuse: "no forge.yaml found; run forge create first".

If `forge.yaml` exists but is malformed (invalid YAML or missing `bindings` section), report the parse error and ask the operator to fix it before re-running.

### 5. Mode choice

Ask the operator:

> Are you starting a new project (greenfield) or bringing an existing codebase into forge (transplant)?

- **greenfield** → full interview (step 6)
- **transplant** → source-directory interview (step 6)

### 6. Greenfield or transplant interview

#### Greenfield

1. **Stack** — ask what stack the project uses (TypeScript, Python, Rust, etc.). Write into `forge.yaml` `project.stack`.
2. **Package manager** — confirm or override `project.packageManager` in `forge.yaml`.
3. **Stack bindings** — fill `commands.typecheck`, `commands.test`, `commands.scopedBuild` in `forge.yaml`. Ask the operator for the exact commands (e.g. `tsc --noEmit`, `vitest`, `turbo run build`).
4. **Git init** — check if `.git` exists in the project root. If not, run `git init` and make an initial commit with all project files. If `.git` already exists, proceed.

#### Transplant (adapter-driven migration)

The transplant mode performs real code migration via a migration-adapter registry. Each adapter declares four phases: detect, analyze, migrate, post-setup.

1. **Source directory** — ask for an absolute or relative path to the external codebase. Resolve and validate. The source must be outside the current forge project.
2. **Detect adapter** — iterate the migration-adapter registry, call `detect()` on each adapter against the source directory. If multiple adapters match, ask the operator to choose. If none match, report "no migration adapter detected for this project type" and fall back to the greenfield interview for bindings (no code migration).
3. **Analyze** — call `analyze()` on the matched adapter. Present: detected stack, proposed bindings (`typecheck`, `test`, `scopedBuild`), placement (`apps/<appName>/`), exclude patterns. The operator confirms or edits.
4. **Migrate** — call `migrate()` on the matched adapter. Show any file conflicts before copying. The operator confirms. The adapter copies ALL files from the source directory into `apps/<appName>/`, including untracked and git-ignored files (e.g. `.env`, `.env.local`, secret configuration, local certificates, input data, runtime state). Only `node_modules/`, `dist/`, `.next/`, `.cache/`, `.turbo/`, `.git/`, and other build artifacts are excluded. Forge-protected files (`forge.yaml`, `.agents/`, `docs/rfcs/`, `docs/adrs/`, `PREFERENCES.md`) are never overwritten. Untracked files are essential — the project must work immediately after onboarding with minimal manual fixes.

   4.1. **Discover git-ignored files** — before copying, scan the source project for git-ignored and untracked files using `discoverIgnoredFiles()`. This function runs `git status --ignored --porcelain` in the source directory, categorizes each ignored path, and returns sized categories:
   - **Configuration & secrets** (`.env`, `.env.local`, `*.key`, `*.pem`, certificates, `.envrc`) — selected by default, operator must explicitly opt out.
   - **Data & inputs** (`.input/`, `input/`, `data/`, `batches/`, `*.db`, `*.ndjson`) — selected by default if total size < 1 GB, otherwise ask the operator.
   - **Runtime state** (`storage/`, `.state/`, `*.log`) — not selected by default, operator must opt in.
   - **Caches** (`.cache/`, `cache/`, `.playwright`, `browser-profile`, `*.tmp`) — not selected by default, operator must opt in.
   - **Other** — any git-ignored file not matching the above categories — not selected by default, operator must opt in.

   For each category, present: label, description, file count, total size (formatted), and a few example paths. The operator selects which categories to transfer.

   If `discoverIgnoredFiles()` returns no categories (no `.git` in source, or no ignored files), skip this step entirely — `migrate()` already copies all files on disk.

   4.2. **Copy selected ignored files** — after `migrate()` completes, copy the operator-selected git-ignored file categories from the source to `apps/<appName>/`. For each selected category, copy every path in that category from the source to the corresponding location under `apps/<appName>/`. Use `fs.cpSync(src, dest, { recursive: true })` for directories and `fs.copyFileSync` for individual files. Report what was copied (category, file count, total size) in human language.

   4.3. **Verify untracked files** — after all copies complete, verify that essential untracked files (`.env`, `.env.local`, and other dotfiles present in the source) were copied to `apps/<appName>/`. If any are missing, copy them manually from the source. Do not skip this step — missing `.env` files are the most common cause of a non-functional project after onboarding.

5. **Git history transfer** — if the source project has a `.git` directory, ask the operator:

   > Your source project has Git history. Would you like to transfer the commit history into the new Forge project?

   If yes: the skill uses `git format-patch` (export all commits from source) + `git am` (apply them in the new project) to preserve history without copying the `.git` directory. If the source has many commits, warn that this may take a moment.

   If no: the skill runs `git init` in the new project (clean repository, no history from source).

   If git history transfer fails (complex history, submodules, replace objects): warn and continue with a clean `git init`.

   If the source project has no `.git` directory: skip the git history question and run `git init` directly.

6. **Post-setup** — call `postSetup()`. The adapter initializes git (clean init or format-patch + git am based on operator's choice), updates `pnpm-workspace.yaml` (adds `apps/<appName>`), `turbo.json` (adds workspace to pipeline), runs the install command derived from `ref(forge.yaml project.packageManager)`. The skill captures bin-link ENOENT warnings from the install output — these are cosmetic and indicate that `dist/` does not exist yet (the project has not been built). If the install itself fails (exit code != 0), report the dependency resolution error in human language (in `aiLanguage`), skip build verification, and continue to the welcoming report. The operator can fix and re-run onboarding.

6.7. **Build verification and error repair** — after post-setup, verify the transplanted project builds successfully:

1.  Resolve the build command via `ref(forge.yaml bindings.commands.scopedBuild)`. If the binding is null (the migration adapter could not derive a build command from the source project), skip build verification with a note in the welcoming report and continue to the next step.
2.  Run the resolved build command and capture stdout/stderr. Set a timeout of 300 seconds (configurable); if the build does not complete in time, report the timeout in human language and continue.
3.  Parse build output for:
    - Missing modules (TS2307: Cannot find module 'X')
    - Type errors (TS2xxx)
    - Build command failures (ELIFECYCLE, exit code != 0)
    - Bin-link ENOENT warnings (cosmetic — reported as noise, not blocking)
4.  If errors are detected (excluding bin-link warnings, which are cosmetic):
    - Present errors to the operator in human language (in `aiLanguage`) as a structured list with error code, file path, and message.
    - Ask: "Your project has some build errors. Would you like me to fix them?"
    - If yes: fix errors in-session — install missing dependencies, fix broken import paths, resolve type errors. Do NOT make business logic changes. Re-run the build command to verify. If new errors appear, continue fixing iteratively up to 3 rounds, then report remaining errors.
    - If no: report errors and continue.
5.  If no errors: confirm the project builds successfully.

6.8. **Fill forge.yaml** — write derived bindings into `forge.yaml` (`typecheck`, `test`, `scopedBuild` from the adapter's analysis). Write `project.stack` from the detected stack.

### 6.9. Commit synced skills (RFC-XXXX, both greenfield and transplant)

After git init (greenfield step 6.4) or after post-setup (transplant step 6.6), commit the synced Forge and pack skills to git:

```
git add .agents/skills/
git commit -m "chore: sync Forge skills"
```

This ensures skills are tracked in version control from the start. The commit includes only `.agents/skills/` — no other files.

### 7. Auto-run doctor (new)

The skill runs `forge.doctor` internally — not as a CLI command the operator types. The operator never sees a command or a terminal.

If doctor reports issues, the skill presents them in human language (in `aiLanguage`) with proposed solutions. The operator can choose to fix or defer.

If doctor passes, the skill confirms everything is healthy.

If `forge.doctor` is unavailable (forge not installed as devDependency yet), the skill skips auto-doctor and notes it in the report. The operator can ask the agent to run it later.

### 8. Auto-create ADR (new, both greenfield and transplant, silent)

The skill invokes `/fo-idea-create-adr` inline with a pre-filled title:

- Greenfield: "Start new project with Forge"
- Transplant: "Migrate <source-project> into Forge"

Context: stack, bindings, mode. Justification: the operator's reason for adopting Forge (asked during the interview).

The ADR is created, validated, and committed silently — the operator is not told about ADRs, RFCs, or governance concepts. These become visible naturally during work when the operator encounters them in context.

If auto-ADR creation fails (validation fails), the skill reports the error silently (in agent logs, not to the operator), leaves the ADR file in place for the agent to fix, and continues to the welcoming report. The operator is never told about the ADR.

### 9. Project analysis and recommendations (new, transplant only)

The skill analyzes the transplanted project: codebase structure, git history (if transferred), content, and configuration. It generates 2-3 recommendations from a creator's perspective — improvements that demonstrate the system's value and make the operator want to start working.

Recommendations are not technical refactors; they are creator-facing improvements (e.g. content opportunities, user experience enhancements, creative direction suggestions). The skill presents each recommendation with:

- **What** — a short, creator-facing description of the improvement.
- **Why** — why it matters from a creator's perspective (not a programmer's).
- **Result** — what the result would look and feel like.

The operator can choose to start one immediately or defer.

If project analysis finds nothing recommendable (transplant of an empty or minimal project), the skill skips recommendations and proceeds to the first creation moment with a direct invitation to start creating.

### 9.1. Hand-written AGENTS.md improvement proposals (transplant only)

After project analysis, the skill checks existing hand-written `AGENTS.md` files in workspace directories (directories with a `package.json`). For each hand-written `AGENTS.md` (one without a generated marker), the skill checks for common forge conventions:

- Does the file reference the root `AGENTS.md` for project-wide rules?
- Does the file include workspace-type-appropriate guidance (app, package, service)?
- Does the file contain a generated marker (it should not for hand-written files)?

If improvement opportunities are found, the skill proposes them to the operator in creator-facing language (in `aiLanguage`). The operator confirms before any file is modified. Proposals are opt-in — the operator can decline all or select specific improvements.

If no hand-written `AGENTS.md` files exist, or no improvement opportunities are found, this step is skipped silently.

### 10. First creation moment (new)

After the welcoming report, the skill helps the operator create something real immediately — not a placeholder, not a test, but a first piece of their actual project.

For a game: "Let's create your first scene right now. What's the first thing the player sees?" For a website: "Let's create your first page right now. What's the first thing visitors should see?" For a blog: "Let's write your first post right now. What do you want to tell the world?"

During this creative dialogue, the skill organically collects personal context — project story, deep purpose, creative influences, target audience, writing voice — through the conversation itself, not as a separate interview. The operator's voice is learned from how they describe their idea. The audience is learned from "who is this for?". Creative influences are learned from "what inspires you in similar projects?". This data is stored in `operator-profile.md` under `## Personal`.

If the operator cannot describe what they want to create, the skill offers to start from a template or recommendation (transplant) instead. The first creation moment is an invitation, not a requirement.

### 11. Welcoming report (redesigned)

Presented in the operator's chosen `aiLanguage`. All labels, headings, and descriptions are translated. No CLI commands, no skill names with `fo-` prefix, no internal jargon, no internal mechanism names (ADR, RFC, Compass). The report has six sections:

#### Section 1: Welcome

A brief welcome message acknowledging the operator's project and the completion of onboarding.

#### Section 2: What Forge gives you

A 2-3 sentence value proposition in human language, read from `forge-about.md`. Core message: Forge gives the operator the leverage that previously required a studio of programmers — documentation, decision history, and autonomous implementation — without needing to hire or manage engineers. The system also learns: with every conversation, it understands the operator's style, preferences, and creative vision better.

#### Section 3: What was done

A human-language summary of what happened during onboarding. For greenfield: project structure created, language preferences saved, stack configured. For transplant: code migrated, structure created, language preferences saved, stack configured, health check results. The ADR is not mentioned — it is an internal mechanism the operator discovers naturally during work.

#### Section 4: What you can do now

Human-language descriptions of capabilities, not commands. The skill reads the `register` field from `PREFERENCES.md` and presents the register-appropriate list.

**Creative register** — capabilities emphasize creative flow, idea capture, and project growth:

- "Describe an idea and watch it come to life — the system implements it end-to-end."
- "Ask the system to remember your creative influences and aesthetic preferences for future sessions."
- "Explore ideas together without implementing — companion mode for creative exploration."
- "Get a visual preview before any visual change is made — see it before you commit."
- "Ask the system to check your project's health and suggest improvements."

**Business register** — capabilities emphasize efficiency, quality, and project management:

- "Describe a change or feature and the system implements it end-to-end."
- "Request a project health check — the system verifies consistency and reports issues."
- "Ask for a review of recent changes — the system checks quality and alignment."
- "Get recommendations for project improvements based on analysis."
- "Track project decisions and history automatically — nothing is lost."

The operator does not need to know skill names or CLI commands. The LLM agent interprets their natural-language requests and invokes the appropriate skills.

#### Section 5: Let's start (transplant: recommendations)

For greenfield: an immediate invitation to start creating — "Tell me what you want to build, and I'll make it happen."

For transplant: the 2-3 recommendations from step 9 are presented here. The operator can choose to start one immediately or describe their own idea. The skill does not push — it offers and waits.

If the first creation moment (step 10) already produced something, the report acknowledges it.

#### Section 5.1: Skipped skills report

If `runInit()` returned `skippedSkills` (pack skills that conflict with Forge skills), report each skipped skill to the operator in human language (in `aiLanguage`):

> The following skills were not transferred because they conflict with Forge skills: [list]. You can rename them after onboarding if you want to keep them.

If no skills were skipped, this section is omitted.

#### Section 6: What Forge is and is not

A short description after every onboarding, read from `forge-about.md`. The skill reads the knowledge file and presents its "What Forge is" and "What Forge is not" sections in the operator's `aiLanguage`.

### 12. Failure modes

- Not in a forge project → skill refuses: "no forge.yaml found; run forge create first".
- Malformed `forge.yaml` → skill reports the parse error and asks the operator to fix it before re-running.
- Stack binding already non-null → skill skips it (respects operator overrides).
- Transplant source unreadable → skill reports and asks for a different path.
- Transplant source is inside the forge project → skill refuses: "source must be outside the forge project".
- No adapter matches the source directory → skill reports "no migration adapter detected for this project type" and falls back to the greenfield interview for bindings (no code migration).
- Multiple adapters match → skill asks the operator to choose.
- File conflict (source and forge both have the same non-protected file) → skill shows the conflict and asks the operator to choose (source-wins or forge-wins).
- `forge.doctor` finds issues → skill presents them in human language with proposed solutions; operator can choose to fix or defer.
- `forge.doctor` is unavailable → skill skips auto-doctor and notes it in the report; operator can ask the agent to run it later.
- Auto-ADR creation fails → skill reports the error silently (in agent logs, not to operator), leaves the ADR file in place for the agent to fix, and continues to the welcoming report. The operator is never told about the ADR.
- Project analysis finds nothing recommendable (transplant) → skill skips recommendations and proceeds to the welcoming report with a direct invitation to start creating.
- Git history transfer fails → skill warns and continues with clean `git init`.
- Source project has no `.git` → skill skips the git history question and runs `git init` directly.
- Post-setup `pnpm install` fails → skill reports the error; the operator can fix and re-run `pnpm install` manually.
- Migration interrupted mid-copy (process crash, agent termination) → `migrate()` is idempotent: re-running skips files that already exist at the target with matching content. The operator can also delete `apps/<appName>/` and re-run for a clean migration.
- Concurrent execution (two agents running `forge-bootstrap` transplant on the same forge project simultaneously) → the skill does not lock `apps/<appName>/`; concurrent writes may conflict. The operator should not run two transplant operations on the same project in parallel.
- Operator cancels mid-interview → partial changes to `forge.yaml` and `apps/<appName>/` are left; the skill does not roll back.
- Operator declines everything (git history, ADR, first creation moment) → valid; the skill proceeds to the welcoming report with what was done. No step is mandatory beyond language selection, register selection, and project verification.
- First creation moment fails (operator cannot describe what they want) → skill offers to start from a template or recommendation (transplant) instead. The first creation moment is an invitation, not a requirement.

### 13. Knowledge files

The skill declares the following knowledge files in its `knowledge` frontmatter array:

- `forge-about.md` — Forge self-description, capabilities, value proposition. Read when the operator asks about the system at any point — not proactively during onboarding. The knowledge file is the single source of truth for self-description.
- `operator-profile-template.md` — template for initial `operator-profile.md` with empty sections. Created by forge-bootstrap, grown by fo-session-retro and live operator feedback per RFC-XXXX.
- `project-narrative-template.md` — template for initial `project-narrative.md`. Used by RFC-XXXX audience empathy.
- `milestone-gallery/` — directory for project milestone snapshots. Used by RFC-XXXX visual thinking.

### 14. Privacy

`operator-profile.md` contains personal data: operator name, gender, form of address, project story, deep purpose, creative influences, target audience, writing voice. Gender is special category data under GDPR Article 9. To prevent accidental exposure:

- `operator-profile.md` is in `.gitignore` (added by scaffold profiles).
- The skill informs the operator that `operator-profile.md` is local and private — it is not committed to the repository.
- Gender is optional: the operator may decline to provide it. If declined, the skill uses gender-neutral addressing.
- The operator can delete `operator-profile.md` at any time; the system continues to function without it.
