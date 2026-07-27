/*
<MODULE_CONTRACT>
<purpose>CLI output rendering helpers (RFC-0542) — renderNextSteps,
renderIdeRecommendation, generateHelp. Pure functions, no I/O, no process.exit.
Importable by bin/cli.ts and unit tests.</purpose>
<non-goals>
  <item>Do not call console.log or process.exit — callers handle output.</item>
  <item>Do not import from bin/ — this is the portable layer.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-0542: initial CLI output rendering helpers — renderNextSteps, renderIdeRecommendation, generateHelp.</item>
</CHANGE_SUMMARY>
*/

import type { ForgeNextStep, CommandRegistry } from "./types.ts";

export function renderNextSteps(steps?: ForgeNextStep[]): string {
  if (!steps || steps.length === 0) return "";
  const lines = ["\nNext steps:"];
  for (const step of steps) {
    const label = step.kind === "required" ? "[must do]" : "[can do]";
    lines.push(`  • ${step.action}        ${label}`);
  }
  return lines.join("\n");
}

export function renderIdeRecommendation(): string {
  return "\nRecommended IDE: Windsurf (tested with forge). Other IDEs (VS Code, Cursor)\nwork but are not tested.";
}

export function generateHelp(registry: CommandRegistry): string {
  const commands = registry.listCommands();
  const header = `forge — autonomous project tooling

Usage:
  forge <command> [args...] [--flags...]
  forge --help <command>    Show per-command flags and description

Flags:
  --json              Output results as JSON
  --dry-run           Show what would happen without making changes
  --site <name>       Target a specific site/app
  --version           Show forge version
  --help              Show this help (or per-command help with --help <command>)

Registered commands (${commands.length}):`;

  const commandLines = commands
    .map((cmd) => {
      const desc =
        cmd.description.length > 80 ? cmd.description.slice(0, 77) + "..." : cmd.description;
      return `  ${cmd.name.padEnd(40)} ${desc}`;
    })
    .join("\n");

  return `${header}\n${commandLines}\n`;
}
