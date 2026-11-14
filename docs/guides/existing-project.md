# Bring an existing project into Forge

Transplanting an existing codebase into Forge is an interactive, AI-guided process.

## Steps

1. **Create a Forge project shell.**

   ```sh
   mkdir my-project && cd my-project
   pnpm dlx @warpgogol/forge@latest create --in-place --profile forge-shell
   ```

2. **Open the project in your AI IDE.**

3. **Run the `/forge-bootstrap` skill and choose "transplant" mode.**

   The skill will:
   - Ask for the path to your existing codebase
   - Detect the stack automatically (Phaser, Godot, TypeScript, etc.)
   - Migrate all files (including `.env` and git-ignored files)
   - Optionally transfer git history
   - Verify the build

4. **Verify project health.**

   ```sh
   pnpm exec forge doctor
   ```

## What happens during transplant

- Your existing files are moved into the Forge project structure
- Hidden files (`.env`, `.gitignore`) are preserved
- Git history is optionally transferred
- The matching stack profile is detected from marker files (`phaser.config.*`, `project.godot`, etc.) <!-- pkg-health-12: code/config path, not a command -->
- `AGENTS.md` is generated from `forge.yaml`
- Skills are deployed to `.agents/skills/`

## Safety checklist

Before transplanting:

- **Commit or stash all work in the source project** — a clean source tree makes the post-transplant diff reviewable and recovery trivial.
- **Keep a backup of the source directory** until the transplanted project verifies green (`forge doctor` + your build). The transplant moves files; the backup is the rollback.
- **Audit secrets before migrating.** `.env` and git-ignored files are migrated by design — afterwards, confirm secrets landed only in git-ignored paths of the target and rotate any credential that had ever been committed to history.
- **Review the diff before your first commit** — `git status` and `git diff` show exactly what the skill added (`forge.yaml`, `AGENTS.md`, `.agents/skills/`, profile config) versus what it left untouched.
- **Prefer skipping git history** for projects with secrets in past commits — history transfer is optional, not required.

Recovery: if verification fails, restore from the backup and re-run the bootstrap — the skill does not modify anything outside the target project directory.
