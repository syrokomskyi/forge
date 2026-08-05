---
name: ef-composition-review
description: Review an Editframe HTML composition for time model correctness, accessibility, and best practices
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

<!-- skill-lint-disable SKILL-17 -->

# ef-composition-review

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

A read-only review of an Editframe HTML composition file. The skill checks time model correctness, accessibility, asset references, automated invariants, and manual best practices. It does **not** modify any file — it produces a structured report and stops.

## Scope

This skill reviews `.html` composition files that use Editframe custom elements (`ef-timegroup`, `ef-video`, `ef-audio`, `ef-text`, `ef-captions`). It is designed for projects using the `editframe-html` stack profile.

## Process

### 1. Empty state check

Scan the `compositions/` directory for `.html` files. If no compositions are found, report "No compositions found — nothing to review" and stop. Do not report false positives on an empty project.

### 2. Time model review

For each composition file:

- Check that the root `ef-timegroup` declares a `duration` attribute or uses `mode="contain"` / `mode="fit"`.
- Check that all `duration` and `offset` values are valid CSS time strings (e.g. `5s`, `300ms`, `2.5s`).
- Check that `mode` values are one of: `sequence`, `fixed`, `contain`, `fit`.
- Check that `fps` is a positive integer (e.g. `30`, `60`).
- Check that `loop` is only present on the root `ef-timegroup` — nested timegroups should not loop.

### 3. Accessibility review

- Check that all `ef-audio` elements with speech content have corresponding `ef-captions` elements.
- Check that `ef-text` elements have sufficient contrast between foreground and background colors (if declared via inline styles or CSS classes).

### 4. Asset reference review

- Check that all `src` attributes in `ef-video`, `ef-audio`, and `ef-image` elements point to files that exist in the `assets/` directory.
- Check that asset filenames use kebab-case (lowercase letters, digits, hyphens only).

### 5. Invariant check

Run `forge doctor` to check all profile invariants automatically. For the `editframe-html` profile, this covers VIDEO-01 through VIDEO-09 (filename conventions, scene fit modes, captions, and time model invariants). Review the output and include any violations in the report.

### 6. Manual best practices

Review aspects not covered by automated invariants:

- Scene composition quality — are scenes well-structured with clear transitions?
- Narrative pacing — does the timing flow naturally?
- Visual hierarchy — are text elements readable and well-positioned?
- Asset reuse — are assets reused efficiently across scenes?

Do not duplicate checks that `forge doctor` already performs.

### 7. Report

Summarize findings organized by category (time model, accessibility, assets, invariants, best practices). For each finding, include the file path, line number (if applicable), severity (error / warning / info), and a specific recommendation.
