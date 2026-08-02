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

### 8. GitHub Actions CI (optional)

If the project uses GitHub Actions, generate or update `.github/workflows/ci.yml` with the following Windows-specific guidance:

#### Action versions

Use the latest official actions with Node 24 runtime:

- `actions/checkout@v5`
- `actions/setup-node@v5`

These versions use the Node 24 runtime that GitHub Actions now recommends. Older versions (`@v4` and below) run on the deprecated Node 20 runtime.

#### Windows runner images

Do not pin to `windows-latest` blindly — the image composition changes over time and a toolchain that worked yesterday may break today. If native compilation is critical, pin to a specific Windows image version (e.g. `windows-2022`) and verify the actual compiler version in CI output.

Do not hardcode the path to Visual Studio and do not let tooling auto-select the newest installed version. Some `node-gyp` versions do not yet recognize Visual Studio 2026. For those, install Visual Studio Build Tools 2022 and constrain the toolset search to the `[17.0,18.0)` range:

```yaml
- name: Set up Build Tools 2022
  run: |
    $vsPath = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" `
      -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -property installationPath -version "[17.0,18.0)"
    echo "VS_PATH=$vsPath" >> $env:GITHUB_ENV
```

Before installing dependencies, activate the Developer Command Prompt for the discovered Visual Studio in the same step so that `cl.exe` and the MSVC toolchain are on `PATH`:

```yaml
- name: Activate Developer Command Prompt
  shell: cmd
  run: |
    call "%VS_PATH%\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
    pnpm install --frozen-lockfile
```

#### Native dependencies

Native dependencies (SQLite drivers, `better-sqlite3`, `sharp`, `node-sass`, etc.) need CI testing on each target OS. A prebuilt binary may not exist for every Node version + OS + architecture combination — when it is missing, `node-gyp` falls back to source compilation and requires a working C++ compiler.

Verify in CI that `pnpm install` succeeds without manual intervention on every OS in the matrix. If it fails, either:

- Add `node-gyp` build prerequisites to the CI step (Build Tools + Developer Command Prompt), or
- Pin to a Node version that has prebuilt binaries for all target platforms.

#### Windows long paths

If Windows is in the CI matrix, set `core.longpaths` **before** the checkout step via job-level env:

```yaml
jobs:
  windows-ci:
    runs-on: windows-2022
    env:
      GIT_CONFIG_COUNT: 1
      GIT_CONFIG_KEY_0: core.longpaths
      GIT_CONFIG_VALUE_0: "true"
    steps:
      - name: Checkout
        uses: actions/checkout@v5
      # ...
```

Without this, `git clone` fails on repositories with file paths longer than 260 characters (common in monorepos with deeply nested `node_modules` or generated content trees).

#### When to include Windows

Windows CI catches important platform-specific issues (path lengths, native builds, line endings), but it requires separate configuration of native dependencies, compiler toolchain, and shell differences (PowerShell vs bash). Only add Windows to the CI matrix where the product genuinely supports or ships Windows artifacts — not "just in case".

#### CI reliability patterns (all platforms)

Apply these to every workflow, not just Windows:

**Concurrency cancellation** — cancel superseded runs on PRs to save CI minutes and avoid cache thrashing:

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

**Minimal permissions** — default GitHub Actions grants `contents: write`. Restrict to read-only at the workflow level; escalate per-job only where needed (e.g. changelog commit):

```yaml
permissions:
  contents: read
```

**Job timeouts** — the default 6-hour timeout can exhaust CI limits on a hung install or test. Set `timeout-minutes` per job: 10–15 for lint/validate, 20–30 for build/test.

**Deterministic timezone** — tests using `new Date()` produce different results depending on the runner's timezone. Set `TZ: UTC` at the job level to make timestamps deterministic across runs:

```yaml
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      TZ: UTC
```

**Explicit shell** — on Windows the default shell is PowerShell, which breaks bash syntax. Steps using bash must declare `shell: bash`; Windows-specific steps should declare `shell: cmd` or `shell: pwsh`:

```yaml
- name: Run bash script
  shell: bash
  run: ./scripts/build.sh
```

#### Package-scoped commands

Do not run package-level tools (test runners, linters, build commands) from the monorepo root. Run them via the package's own script or workspace context:

```yaml
# Good — scoped to the package
- run: pnpm --filter <package-name> test

# Bad — runs from root, may pick up wrong config
- run: pnpm test
```

Ask: **"Настроить GitHub Actions CI для Windows? (Y/m/s)"**. Default **Y** if the project already has `.github/workflows/`; otherwise **s** (skip — the scaffolded CI template already includes Ubuntu-only CI).

## Constraints

- Default to automatic execution (`Y`) for every step. Offer `m` (manual) and `s` (skip) only as explicit opt-outs.
- Do not run any step automatically if the operator chose `m` or `s` for that step.
- Do not overwrite an existing `.gitattributes` without explicit confirmation, even in automatic mode.
- Do not create `AGENTS.md` when `CLAUDE.md` already exists unless the operator explicitly chose to.
- Do not assume the project is TypeScript, Turborepo, or Astro. This skill is generic; add project-specific rules only when the operator asks.
- Keep the verified winget IDs as the single source of truth. Do not invent package IDs; if an ID changes, update this skill and notify the operator.
- **Commit only your own files.** Stage only the files this skill produces or modifies — `.gitattributes`, `AGENTS.md` / `CLAUDE.md`, `PREFERENCES.md`. Do not stage unrelated changes. Another agent may be working in a different session; `git add -A` or `git add .` is forbidden.
