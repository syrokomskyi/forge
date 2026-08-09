#!/usr/bin/env node
/*
<MODULE_CONTRACT>
<purpose>CLI bin entrypoint for @warpgogol/forge — minimal command runner that
registers forge modules and dispatches commands. Works autonomously without
@warpgogol/werkstatt.</purpose>
<non-goals>
  <item>Do not implement command logic — delegate to forge os/ modules and src/ handlers.</item>
  <item>Do not replicate the full kernel runtime — minimal dispatch only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Initial CLI bin entrypoint for forge autonomy refactor.</item>
  <item>RFC-0542: self-documenting output contract — renderNextSteps, renderIdeRecommendation, generateHelp, --help <command> flag.</item>
  <item>RFC-0543: source VERSION from package.json at runtime instead of hardcoded constant.</item>
</CHANGE_SUMMARY>
*/

import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger = {
  section(msg: string, details?: unknown) {
    console.log(`\n■ ${msg}`);
    if (details) console.log(details);
  },
  info(msg: string, details?: unknown) {
    console.log(`  ${msg}`);
    if (details) console.log(details);
  },
  warn(msg: string, details?: unknown) {
    console.warn(`  ⚠ ${msg}`);
    if (details) console.warn(details);
  },
  error(msg: string, details?: unknown) {
    console.error(`  ✖ ${msg}`);
    if (details) console.error(details);
  },
  success(msg: string, details?: unknown) {
    console.log(`  ✓ ${msg}`);
    if (details) console.log(details);
  },
};

// ---------------------------------------------------------------------------
// Minimal registry
// ---------------------------------------------------------------------------

import type {
  ForgeCommandDefinition,
  ForgeCommandInput,
  ForgeCommandResult,
  ForgeRuntimeContext,
  ForgeFlagValue,
  CommandRegistry,
  ForgeRegisteredCommandInfo,
} from "../src/types.ts";
import { renderNextSteps, renderIdeRecommendation, generateHelp } from "../src/cli-output.ts";
import type { ForgeModule, ForgeModuleRegistry, ForgePipelineStep } from "../src/forge-module.ts";

class ForgeCliRegistry implements ForgeModuleRegistry, CommandRegistry {
  private commands = new Map<string, ForgeCommandDefinition>();

  registerCommand(command: ForgeCommandDefinition): void {
    this.commands.set(command.name, command);
  }

  registerPipeline(_name: string, _steps: ForgePipelineStep[]): void {
    // CLI mode: pipelines not supported — no-op
  }

  listCommandNames(): string[] {
    return [...this.commands.keys()].sort();
  }

  listCommands(): ForgeRegisteredCommandInfo[] {
    return [...this.commands.values()].map((c) => ({
      name: c.name,
      description: c.description,
      scope: c.scope,
      provider: "workspace" as const,
      mutatesState: c.mutatesState,
      requiresNetwork: c.requiresNetwork,
      supportsAllSites: c.supportsAllSites,
      timeoutMs: c.timeoutMs,
      expectedDurationMs: c.expectedDurationMs,
      longRunning: c.longRunning,
      flags: c.flags,
      reads: c.reads,
      writes: c.writes,
    }));
  }

  getCommand(name: string): ForgeCommandDefinition | undefined {
    return this.commands.get(name);
  }
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { flags: Record<string, ForgeFlagValue> } {
  const flags: Record<string, ForgeFlagValue> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const eqIndex = arg.indexOf("=");
      if (eqIndex > 0) {
        const key = arg.slice(2, eqIndex);
        const value = arg.slice(eqIndex + 1);
        flags[key] = value;
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      // RFC-0609: positional arguments are no longer collected; ignore them
    }
  }

  return { flags };
}

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

async function buildRegistry(): Promise<ForgeCliRegistry> {
  const registry = new ForgeCliRegistry();

  const modules: ForgeModule[] = [
    await import("../os/core/core.module.ts").then((m) => m.forgeCoreModule),
    await import("../os/rfc/rfc.module.ts").then((m) => m.forgeRfcModule),
    await import("../os/workflow/workflow.module.ts").then((m) => m.forgeWorkflowModule),
    await import("../os/naming/naming.module.ts").then((m) => m.forgeNamingModule),
    await import("../os/compass/compass.module.ts").then((m) => m.forgeCompassModule),
    await import("../os/werkstatt/werkstatt.module.ts").then((m) => m.forgeWerkstattModule),
    await import("../os/session/session.module.ts").then((m) => m.forgeSessionModule),
    await import("../os/exploration/exploration.module.ts").then((m) => m.forgeExplorationModule),
  ].filter((m): m is ForgeModule => m !== null);

  for (const mod of modules) {
    await mod.register(registry);
  }

  return registry;
}

// ---------------------------------------------------------------------------
// Output rendering (RFC-0542: self-documenting forge command output contract)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Version — sourced from package.json at runtime (RFC-0543)
// ---------------------------------------------------------------------------

function readVersion(): string {
  // Source: packages/forge/bin/cli.ts → packages/forge/package.json (one up)
  // Compiled: dist/bin/cli.js → package.json (two up)
  for (const up of ["..", "../.."]) {
    const pkgPath = join(__dirname, up, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next candidate
    }
  }
  return "0.0.0-unknown";
}

const VERSION = readVersion();

function resolveForgeRootFromCli(): string | undefined {
  // Source: packages/forge/bin/cli.ts → packages/forge/ (one up)
  // Compiled: dist/bin/cli.js → packages/forge/ (two up)
  for (const up of ["..", "../.."]) {
    const pkgPath = join(__dirname, up, "package.json");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name === "@warpgogol/forge") return join(__dirname, up);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

function printCommandHelp(registry: ForgeCliRegistry, commandName: string): void {
  const resolved = resolveCommandName(commandName, registry);
  const cmd = resolved ? registry.getCommand(resolved) : undefined;
  if (!resolved || !cmd) {
    logger.error(`Unknown command: ${commandName}`);
    logger.info(`Run 'forge --help' for available commands.`);
    process.exit(1);
  }
  const displayName = resolved.replace(/^forge\./, "");
  console.log(`forge ${displayName}`);
  console.log(`\n  ${cmd.description}`);
  if (cmd.flags && Object.keys(cmd.flags).length > 0) {
    console.log("\nFlags:");
    for (const [flagName, flagSpec] of Object.entries(cmd.flags)) {
      const required = flagSpec.required ? " (required)" : "";
      console.log(`  --${flagName}${required}  ${flagSpec.description}`);
    }
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Command-name resolution (RFC-0699)
// ---------------------------------------------------------------------------

function resolveCommandName(commandName: string, registry: ForgeCliRegistry): string | undefined {
  if (registry.getCommand(commandName)) {
    if (commandName.startsWith("forge.")) {
      const unqualified = commandName.slice("forge.".length);
      logger.warn("'" + commandName + "' is deprecated; use '" + unqualified + "'");
    }
    return commandName;
  }
  if (!commandName.includes(".")) {
    const qualified = "forge." + commandName;
    if (registry.getCommand(qualified)) {
      return qualified;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || (argv[0] === "--help" && argv.length === 1) || argv[0] === "-h") {
    const registry = await buildRegistry();
    console.log(generateHelp(registry));
    process.exit(0);
  }

  if (argv[0] === "--help" && argv.length >= 2) {
    const registry = await buildRegistry();
    printCommandHelp(registry, argv[1]);
    return;
  }

  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(`forge ${VERSION}`);
    process.exit(0);
  }

  const commandName = argv[0];
  const rest = argv.slice(1);
  const { flags } = parseArgs(rest);

  const registry = await buildRegistry();
  const resolved = resolveCommandName(commandName, registry);
  const command = resolved ? registry.getCommand(resolved) : undefined;

  if (!command) {
    logger.error(`Unknown command: ${commandName}`);
    logger.info(`Run 'forge --help' for available commands.`);
    process.exit(1);
  }

  const workspaceRoot = resolve(process.cwd());
  const outputFormat = flags["json"] === true ? "json" : "pretty";
  const dryRun = flags["dry-run"] === true;

  const input: ForgeCommandInput = { argv: rest, flags };
  const resolvedForgeRoot = resolveForgeRootFromCli();
  if (outputFormat === "pretty" && commandName === "forge.create") {
    logger.info(`forge root: ${resolvedForgeRoot ?? "(not resolved)"}`);
  }

  const context: ForgeRuntimeContext = {
    workspaceRoot,
    forgeRoot: resolvedForgeRoot,
    logger,
    dryRun,
    outputFormat,
    commandRegistry: registry,
  };

  try {
    const result = (await command.execute(input, context)) as ForgeCommandResult | void;
    if (result && outputFormat === "json") {
      const output = { ...(result.data ?? {}), nextSteps: result.nextSteps ?? [] };
      console.log(JSON.stringify(output, null, 2));
    } else if (result && outputFormat === "pretty") {
      if (result.summary) {
        console.log(result.summary);
      }
      const nextStepsText = renderNextSteps(result.nextSteps);
      if (nextStepsText) {
        console.log(nextStepsText);
      }
      if (commandName === "forge.create") {
        console.log(renderIdeRecommendation());
      }
    }
    const exitCode = result?.exitCode ?? 0;
    process.exit(exitCode);
  } catch (error) {
    logger.error(
      error instanceof Error ? error.message : String(error),
      error instanceof Error && error.stack ? error.stack : undefined,
    );
    process.exit(1);
  }
}

main().catch((error) => {
  logger.error(
    error instanceof Error ? error.message : String(error),
    error instanceof Error && error.stack ? error.stack : undefined,
  );
  process.exit(1);
});
