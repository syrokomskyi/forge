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

Guide the operator through creating a new Editframe video project within a Forge-managed workspace. The skill covers prerequisites check, discovery, scaffold, domain knowledge reading, and build + preview.

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

3. **Node.js/React libraries**: Ask if the operator has any libraries in mind (e.g. AnimeJS for animations, Tailwind for styling).

Prioritize getting all answers before starting to build. This minimizes wait time for the operator.

### 3. Scaffold

Run `forge create --profile editframe` to scaffold the project with Forge governance (invariants, AGENTS.md templates, forge skills). The `editframe` profile scaffolds a React + TypeScript + Vite project with `@editframe/react` pre-configured.

If `forge create` fails (missing profile, network error, permission issue), report the error to the operator and stop. Do not proceed to subsequent steps without a scaffolded project.

### 4. Read domain knowledge

Before building, the agent MUST read the vendored Editframe domain skills. These are bundled with `@warpgogol/forge` and available in `.agents/skills/`:

- **ef-composition** — time model, media elements, rendering pipeline
- **ef-dev-server** — Vite plugin setup, local asset serving
- **ef-editor-gui** — editor toolkit for visual composition editing
- **ef-webhooks** — webhook notifications for render completion
- **ef-brand-video-generator** — brand video generation templates
- **ef-motion-design** — motion design patterns, transitions, kinetic typography

The agent should also read **ef-composition-review** and **ef-render-verify** for quality assurance workflows.

### 5. Build and preview

1. Build the initial composition based on the operator's answers from Step 2. Use the discovery answers (project type, assets, libraries) to determine composition structure, asset placement, and optional dependencies.
2. Run `forge dev` to start the preview server (delegates to `editframe preview` per the `editframe` profile's `devServer.command`).
3. Report the localhost URL to the operator.
4. Run `forge doctor` to check all profile invariants on the initial composition. For the `editframe` profile, this covers VIDEO-01 through VIDEO-09.
5. Report any invariant violations and suggest fixes.
