---
name: ef-render-verify
description: Verify an Editframe render — validate, build, check determinism, inspect output
invocation: user
category: fo
concerns: read-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

<!-- skill-lint-disable SKILL-17 -->

# ef-render-verify

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

A read-only verification of an Editframe render pipeline. The skill runs validation, build, determinism check, and output inspection, then reports pass/fail for each step. It does **not** modify any file.

## Scope

This skill verifies render output for `.html` composition files using the `editframe-html` stack profile. It uses `forge validate`, `forge build`, and `forge determinism check` — all profile-driven commands.

## Process

### 1. Pre-render validation

Run `forge validate` to check the composition with the profile's validate command (typically `editframe check`). Review the output for any validation errors. If validation fails, report the errors and stop — do not proceed to render.

### 2. Render

Run `forge build` to produce the MP4 output. Review the output for any build errors. If the build fails, report the errors and stop.

### 3. Determinism check

Run `forge determinism check` to verify the render is reproducible — two builds produce identical output. Review the output hash comparison. If the hashes differ, report the mismatch and stop.

### 4. Output inspection

Check the render output:

- Verify the output MP4 file exists at the expected path (`dist/{composition}.mp4`).
- Check that the file size is non-zero.
- Check that the duration matches the root `ef-timegroup`'s `duration` attribute (if ffprobe or equivalent is available).

### 5. Report

Summarize the verification results — pass/fail for each step:

| Step              | Status      | Details                                |
| ----------------- | ----------- | -------------------------------------- |
| Validation        | pass / fail | <error details or "all checks passed"> |
| Build             | pass / fail | <error details or "build completed">   |
| Determinism       | pass / fail | <hash comparison result>               |
| Output inspection | pass / fail | <file exists, size, duration check>    |

If all steps pass, the render is verified. If any step fails, provide specific recommendations for fixing the issue.
