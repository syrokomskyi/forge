---
name: my-preferences
description: Read, create, or edit the operator's preferences file at the repository root. Run when the operator wants to change language settings for AI conversations, grilling, or project documentation.
invocation: user
category: shared
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

# my-preferences

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing, create it using the semantics below.

Manage the operator's personal settings for AI interaction in this repository. The settings live in `PREFERENCES.md` at the repo root (Markdown with YAML frontmatter).

## Supported preferences

- `aiLanguage` — language the AI uses for **all** communication with the operator in this session: questions, responses, summaries, reports, status updates, and any other chat output.
- `documentationLanguage` — default language for newly generated RFCs, ADRs, READMEs, and other project documentation.

Language values are free-form strings such as `en`, `ru`, `uk`, `de`, `es`. Prefer IETF BCP 47 language tags when the operator provides them.

## Process

### 1. Read the current preferences

Look for `PREFERENCES.md` at the repository root.

- If it exists, read the frontmatter and display the current values.
- If it does not exist, proceed to step 2 (create).

### 2. Ask what to change

If the file exists:

> "Current preferences: aiLanguage = <value>, documentationLanguage = <value>. What would you like to change?"

Let the operator pick one or more keys, or choose "create new preference file from template".

If the file does not exist, ask for the two values one at a time. Use sensible defaults based on the language the operator is already using in the conversation.

For each value, ask:

> "In which language should the AI <respond to you / write project documentation>?"

Accept free-form answers like "Russian", "русский", "uk" or "English".

### 3. Write the file

Use `PREFERENCES.md.template` at the repo root as the baseline if creating the file for the first time. Replace the placeholder values with the operator's answers. Update `updatedAt` to today's date. Preserve any existing body text when only updating values.

### 4. Confirm

Show the operator the final frontmatter and ask if anything else should change. If not, report success and remind them that other interactive skills will read this file at the start of the next session.

### 5. Commit

Commit the preferences file. This is **mandatory** — `PREFERENCES.md` must be committed, not left in the working tree.

Commit message format:

```txt
prefs: update operator preferences

<one-line description of what changed in PREFERENCES.md>.
```

Stage only `PREFERENCES.md` — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

## Constraints

- Do not store secrets, API keys, or environment-specific values in `PREFERENCES.md`.
- Do not delete `PREFERENCES.md` unless the operator explicitly asks.
- Do not change a preference without confirmation.
- Do not add new preference keys beyond the two defined here unless the operator asks and a matching RFC/ADR exists.
- **Commit only your own files.** Stage only `PREFERENCES.md`. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
