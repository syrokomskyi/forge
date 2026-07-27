---
name: windows-ai-tooling
description: Bootstrap a Windows project for AI agents. Installs verified tools, generates .gitattributes, and emits a command allow-list for agent prompts. Run when starting a new project or when agents fail.
invocation: user
category: shared
concerns: document-only
dependsOn: []
languagePolicy: ref(PREFERENCES.md)
---

# Windows AI Tooling

Before starting, read `PREFERENCES.md` at the repository root. If the file is missing or `aiLanguage` is unset, ask the operator once and create the file using the `my-preferences` skill semantics.

Prepare any Windows project so AI agents can work in it reliably. This skill does not assume a Turborepo, TypeScript, or even an existing `AGENTS.md`; it works for any repo that will be edited by AI agents on Windows 10/11.

It produces three artifacts:

1. **Installed tooling baseline** — verified via `winget` and WSL2 where needed.
2. **A project `.gitattributes`** — prevents line-ending drift and marks binary files.
3. **A machine-specific agent prompt snippet** — lists exactly which commands the agent may use.

This is a prompt-driven, interactive skill. Explore the current environment, walk the operator through the decisions one at a time, confirm, then write the files.

## Process

### 1. Read or create operator preferences

Before asking anything, check `PREFERENCES.md` at the repository root.

- If it exists, read the frontmatter and use `aiLanguage` for all subsequent questions and responses in this skill session.
- If it does not exist, ask the operator once:

> "In which language should I ask questions and report results during this session? (e.g., en, ru, uk, de)"

Create `PREFERENCES.md` from `PREFERENCES.md.template` with the operator's answer, plus a reasonable default for `documentationLanguage` (e.g., `en` unless the operator says otherwise). Use the `my-preferences` skill semantics if the operator wants to adjust more than one value.

All further communication with the operator in this skill session must be in the chosen `aiLanguage`.

### 2. Explore the current environment

Before asking about installations, gather the facts. Run the commands below (or their equivalents) and report the results to the operator as a short summary.

- `Get-Command git, node, npm, python, jq, curl, docker, wsl, bash -ErrorAction SilentlyContinue | Select-Object Name, Source, Version`
- `wsl --status` (or `wsl -l -v`)
- `winget --version`
- `git config --global core.autocrlf` and `git config --global core.eol`
- Check whether the project already has `.gitattributes` and `AGENTS.md` / `CLAUDE.md` at the repo root.

Summarize what is present and what is missing. Do not install anything yet.

### 3. Ask the operator for each step (auto-first)

For every section below, follow the same pattern:

1. Briefly explain what the step does and why it matters.
2. Propose the automatic action with the exact command(s).
3. Ask: **"Выполнить этот шаг автоматически? (Y — да / m — дать команды для ручного запуска / s — пропустить)"**. Default: **Y**.
4. If the operator answers `m`, print the exact commands and wait for them to run them manually before continuing. If `s`, skip the step and adjust the generated snippets accordingly.

Do not dump all questions at once. Walk through A → B → C → D one at a time, waiting for an answer before the next section.

#### Section A — Native Windows tools

Explainer: PowerShell-native tools (`git`, `node`, `python`, `jq`, `curl`, `docker`) cover the most common agent needs. They install via verified `winget` IDs.

Automatic command block:

```powershell
winget install -e --id Git.Git
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Python.Python.3
winget install -e --id jqlang.jq
winget install -e --id cURL.cURL
winget install -e --id Docker.DockerDesktop
```

Notes:

- `Git.Git` also installs Git Bash (`bash`, `grep`, `sed`, `awk`, `find`, `tar`, `ls`, `xargs`).
- Docker enables WSL2 integration; skip it if the operator does not want containers.

Ask: **"Выполнить установку недостающих native-инструментов автоматически? (Y/m/s)"**. Default **Y**.

#### Section B — WSL2 Ubuntu bridge

Explainer: Linux-only tools run in WSL2 Ubuntu. This is optional — if skipped, the agent prompt must forbid `wsl`.

Automatic command:

```powershell
wsl --install -d Ubuntu
```

After the reboot, inside Ubuntu:

```bash
sudo apt update && sudo apt install -y build-essential git curl wget jq python3 python3-pip nodejs npm
```

Note: requires a reboot.

Ask: **"Установить WSL2 Ubuntu автоматически? (Y/m/s)"**. Default **Y**.

#### Section C — `.gitattributes`

Explainer: Forces LF line endings and marks binary files, preventing CRLF drift in cross-platform repos.

Automatic action: generate or overwrite `.gitattributes` from `.gitattributes.template`.

Ask: **"Сгенерировать .gitattributes автоматически? (Y/m/s)"**. Default **Y** if missing; ask before overwrite if it already exists.

Use the template in this skill folder as the baseline. Adjust it to the project's actual file extensions (e.g., `.go`, `.rs`, `.java`, `.cs`, `.php`). Do not remove the `* text=auto eol=lf` line or the binary file rules.

#### Section D — AGENTS/CLAUDE integration

Explainer: Adds the Windows tooling section to the existing agent doc or creates a minimal `AGENTS.md`.

Automatic action: edit existing `AGENTS.md`/`CLAUDE.md` or create minimal `AGENTS.md` from `AGENTS_WINDOWS.md.template`.

Ask:

1. Which agent-doc file should be edited? (`AGENTS.md` or `CLAUDE.md`)? If neither exists, create `AGENTS.md`.
2. **"Обновить agent-документ автоматически? (Y/m/s)"**. Default **Y**.

### 4. Generate the agent prompt snippet

After the operator has chosen auto/manual/skip for every section, produce a machine-specific snippet that the operator can paste into their agent's system prompt. The snippet must list exactly which commands are available and which are forbidden, based on the exploration in step 2 and the operator's choices.

Example snippet (adjust to actual machine state):

```markdown
## Windows environment

This project is developed on Windows 10/11. Use the following command rules:

- **Native Windows tools (PowerShell):** `git`, `node`, `npm`, `pnpm`, `python`, `pip`, `jq`, `curl`, `docker`, `wsl`.
- **Git Bash POSIX coreutils:** `bash`, `grep`, `sed`, `awk`, `find`, `tar`, `ls`, `xargs`. Use through `bash -c "..."`. Paths remain Windows-style.
- **WSL2 Ubuntu bridge:** for any GNU tool not listed above, use `wsl <command>` or `wsl bash -c "..."`. Convert Windows paths with `wslpath` first.
- **Not available:** do not call `grep`, `find`, `sed`, `awk`, `jq`, `curl` directly in PowerShell unless they were installed natively and verified.
- **Path rule:** when passing `C:\...` paths to WSL commands, wrap them with `wslpath`:
  `wsl bash -c "cat $(wslpath 'C:\Users\user\file.txt')"`.

Installation fallback (verified winget IDs):
- `winget install -e --id Git.Git`
- `winget install -e --id OpenJS.NodeJS.LTS`
- `winget install -e --id Python.Python.3`
- `winget install -e --id jqlang.jq`
- `winget install -e --id cURL.cURL`
- `winget install -e --id Docker.DockerDesktop`
- `wsl --install -d Ubuntu`
```

If the operator chose not to install WSL, remove the WSL lines and add: `wsl` is not available on this machine — stop and ask the operator before installing it.

### 5. Execute the approved steps

Run only the steps the operator marked as `Y` (automatic). For steps marked `m`, print the exact commands and wait for the operator to run them manually before continuing. For steps marked `s`, skip them and adjust the generated artifacts accordingly.

Order of execution:

1. **Native tools** — run approved `winget install` commands. Show progress; use `--silent` only if the operator explicitly asked for it.
2. **WSL2** — run `wsl --install -d Ubuntu` if approved. Remind the operator that a reboot is required and do not run Ubuntu commands until after the reboot.
3. **`.gitattributes`** — write from `.gitattributes.template` if approved.
4. **Agent doc** — write or edit `AGENTS.md` / `CLAUDE.md` from `AGENTS_WINDOWS.md.template` if approved.
5. **Re-explore** — re-run the exploration commands from step 1 and update the agent prompt snippet with the actual installed paths and versions.
6. **CRLF recovery** — run `git add --renormalize .` only if explicitly requested; otherwise mention it as a manual recovery step.

### 6. Commit

Commit the artifacts produced by this skill. This is **mandatory** — all files created or modified by this skill must be committed, not left in the working tree.

Commit message format:

```txt
tooling: bootstrap Windows AI tooling artifacts

<one-line description of which artifacts were created or updated>.
```

Stage only the files this skill produced or modified (`.gitattributes`, `AGENTS.md` / `CLAUDE.md`, `PREFERENCES.md`) — do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.

### 7. Done

Report:

- Which tools are now installed and which are still pending (e.g., WSL waiting for reboot).
- The exact path of `.gitattributes` and the agent-doc file.
- A copyable block with the agent prompt snippet.
- A reminder that re-running this skill is useful when adding a new tool or onboarding a new machine.

## Constraints

- Default to automatic execution (`Y`) for every step. Offer `m` (manual) and `s` (skip) only as explicit opt-outs.
- Do not run any step automatically if the operator chose `m` or `s` for that step.
- Do not overwrite an existing `.gitattributes` without explicit confirmation, even in automatic mode.
- Do not create `AGENTS.md` when `CLAUDE.md` already exists unless the operator explicitly chose to.
- Do not assume the project is TypeScript, Turborepo, or Astro. This skill is generic; add project-specific rules only when the operator asks.
- Keep the verified winget IDs as the single source of truth. Do not invent package IDs; if an ID changes, update this skill and notify the operator.
- **Commit only your own files.** Stage only the files this skill produces or modifies — `.gitattributes`, `AGENTS.md` / `CLAUDE.md`, `PREFERENCES.md`. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
