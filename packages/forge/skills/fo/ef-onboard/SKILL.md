---
name: ef-onboard
description: Onboard a new Editframe video project — check prerequisites, discover requirements, scaffold, and start preview. Use when the operator asks to create a new video project.
invocation: user
category: fo
concerns: content-mutation
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
triggers:
  - "create a new editframe project"
  - "start a new video project"
  - "build a video with editframe"
  - "create a video composition"
---

<!-- skill-lint-disable SKILL-17 -->

# ef-onboard

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Guide the operator through creating a new Editframe video project within a Forge-managed workspace. The skill covers prerequisites check, discovery, scaffold, Editframe domain skills installation, domain knowledge reading, and build + preview.

## Process

### 1. Prerequisites check

- **Node.js 18+**: Run `node --version`. If missing or below 18, direct the operator to `https://nodejs.org/en/download/` or install via the system package manager.
- **FFmpeg**: Run `ffmpeg -version`. If missing, direct the operator to `https://ffmpeg.org/download.html` or install via the system package manager (`apt install ffmpeg`, `brew install ffmpeg`).
- If either prerequisite is missing and cannot be installed automatically, stop and ask the operator to install it manually.

### 2. Discovery

Ask the operator:

1. **Project type**:
   - Single video (product demo, social media video, personal project)
   - Video template (reusable with different assets — birthday card, wedding announcement)
   - Video editing tool (custom editor built with Editframe as the engine)
   - Video workflow automation (script that generates videos from triggers)
   - Something else (ask them to describe it)

2. **Existing assets**:
   - Video clips, images, or audio files (file paths or URLs)
   - Website URLs to use as content source — if provided, download and cache all relevant assets locally before building
   - No existing assets — start from scratch

3. **Stack preference**:
   - Vanilla HTML/CSS/JS (simpler, no build step beyond Vite)
   - React + TypeScript (component-based, type-safe)
   - No preference — recommend HTML for single videos, React for templates and editors

4. **Node.js/React libraries**: Ask if the operator has any libraries in mind (e.g. AnimeJS for animations, Tailwind for styling).

Prioritize getting all answers before starting to build. This minimizes wait time for the operator.

### 3. Scaffold

Run `forge create --profile editframe-html` to scaffold the project with Forge governance (invariants, AGENTS.md templates, forge skills).

The `editframe-html` profile currently targets HTML compositions only — it does not support a `--template react` flag. If the operator chose React, scaffold with `forge create --profile editframe-html`, then instruct the agent to install `@editframe/react` manually (`pnpm add @editframe/react`) after scaffold.

If `forge create` fails (missing profile, network error, permission issue), report the error to the operator and stop. Do not proceed to subsequent steps without a scaffolded project.

### 4. Install Editframe domain skills

Editframe publishes six domain skills via `npm create @editframe`. To make them available alongside forge skills:

1. Run `npm create @editframe@latest` in the project directory. This installs Editframe's domain skills to `.agents/skills/editframe-*/`.
2. Report which skills were installed.
3. If the command fails (network issues, npm errors, unsupported flags), fall back to referencing the online documentation: direct the agent to read `https://editframe.com/llms.txt` and `https://editframe.com/skills/composition.md` before building. Do not use unverified CLI flags — if `npm create @editframe` prompts interactively, answer the prompts based on the operator's discovery answers from Step 2.

### 5. Read domain knowledge

Before building, the agent MUST read the `editframe-composition` skill (either from `.agents/skills/editframe-composition/SKILL.md` if installed, or from `https://editframe.com/skills/composition.md`). This provides domain knowledge about:

- Time model (`ef-timegroup`, modes, duration, offset)
- Media elements (`ef-video`, `ef-audio`, `ef-image`, `ef-text`, `ef-captions`)
- CSS animations and transitions
- Rendering pipeline

The agent should also read `editframe-dev-server` if the project uses the dev server.

### 6. Build and preview

1. Build the initial composition based on the operator's answers from Step 2. Use the discovery answers (project type, assets, stack preference, libraries) to determine composition structure, asset placement, and optional dependencies.
2. Run `forge dev` to start the preview server (delegates to `editframe preview` per the `editframe-html` profile's `devServer.command`).
3. Report the localhost URL to the operator.
4. Run `forge doctor` to check all profile invariants on the initial composition. For the `editframe-html` profile, this covers VIDEO-01 through VIDEO-09.
5. Report any invariant violations and suggest fixes.
