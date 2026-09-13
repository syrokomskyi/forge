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
- The matching stack profile is detected from marker files (`phaser.config.*`, `project.godot`, etc.)
- `AGENTS.md` is generated from `forge.yaml`
- Skills are deployed to `.agents/skills/`
