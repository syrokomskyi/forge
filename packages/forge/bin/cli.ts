#!/usr/bin/env node
/*
<MODULE_CONTRACT>
<purpose>CLI bin entrypoint for @warpgogol/forge — minimal command runner that
registers forge modules and dispatches commands. Works autonomously without
@warpgogol/werkstatt-engine.</purpose>
<non-goals>
  <item>Do not implement command logic — delegate to forge os/ modules and src/ handlers.</item>
  <item>Do not replicate the full kernel runtime — minimal dispatch only.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>RFC-1478: yaml.scalars.validate + EC-25 colon-space staged lint (F-0006)</item>
  <item>RFC-1486: step 5 — forge-flow module registration + dual CLI/kernel wiring</item>
  <item>RFC-1508: implement RFC-1508 — system profile, system map schemas and system.map.validate</item>
  <item>RFC-1517: make pkg-health-10 shipped-set faithful and scan the publish ref</item>
  <item>ADR-0129: F-0186/F-0187 — FLOW-INT-03 names paths + three-way remedy, FLOW-OPEN-01 same hint, forge CLI kernel-command hint</item>
  <history>RFC-0542, RFC-0543, RFC-1140, RFC-1231, RFC-1336, RFC-1365, RFC-1391, RFC-1433, RFC-1464, RFC-1465, RFC-1466, RFC-1468, RFC-1469, RFC-1470, RFC-1472, RFC-1473</history>
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
  CommandRegistry,
  ForgeRegisteredCommandInfo,
} from "../src/types.ts";
import { renderNextSteps, renderIdeRecommendation, generateHelp } from "../src/cli-output.ts";
import { resolveCliFlags } from "../src/cli-flags.ts";
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
      acceptsAllFlag: c.acceptsAllFlag,
      timeoutMs: c.timeoutMs,
      expectedDurationMs: c.expectedDurationMs,
      longRunning: c.longRunning,
      hidden: c.hidden,
      flags: c.flags,
      reads: c.reads,
      writes: c.writes,
      generates: c.generates,
    }));
  }

  getCommand(name: string): ForgeCommandDefinition | undefined {
    return this.commands.get(name);
  }
}

// ---------------------------------------------------------------------------
// Flag parsing — schema-driven, in src/cli-flags.ts (RFC-0260 kernel parity)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Module registration
// ---------------------------------------------------------------------------

async function buildRegistry(): Promise<ForgeCliRegistry> {
  const registry = new ForgeCliRegistry();

  const modules: ForgeModule[] = [
    await import("../os/core/core.module.ts").then((m) => m.createForgeCoreModule()),
    await import("../os/rfc/rfc.module.ts").then((m) => m.createForgeRfcModule()),
    await import("../os/adr/adr.module.ts").then((m) => m.createForgeAdrModule()),
    await import("../os/plan/plan.module.ts").then((m) => m.createForgePlanModule()),
    await import("../os/audit/audit.module.ts").then((m) => m.createForgeAuditModule()),
    await import("../os/mission/mission.module.ts").then((m) => m.createForgeMissionModule()),
    await import("../os/spec/spec.module.ts").then((m) => m.createForgeSpecModule()),
    await import("../os/program/program.module.ts").then((m) => m.createForgeProgramModule()),
    await import("../os/plugin/plugin.module.ts").then((m) => m.forgePluginModule),
    await import("../os/workflow/workflow.module.ts").then((m) => m.createForgeWorkflowModule()),
    await import("../os/naming/naming.module.ts").then((m) => m.createForgeNamingModule()),
    await import("../os/compass/compass.module.ts").then((m) => m.forgeCompassModule),
    await import("../os/werkstatt/werkstatt.module.ts").then((m) => m.forgeWerkstattModule),
    await import("../os/session/session.module.ts").then((m) => m.createForgeSessionModule()),
    await import("../os/exploration/exploration.module.ts").then((m) =>
      m.createForgeExplorationModule(),
    ),
    await import("../os/notes/notes.module.ts").then((m) => m.createForgeNotesModule()),
    await import("../os/queue/queue.module.ts").then((m) => m.createForgeQueueModule()),
    await import("../os/authority/authority.module.ts").then((m) => m.createForgeAuthorityModule()),
    await import("../os/conformance/conformance.module.ts").then((m) =>
      m.createForgeConformanceModule(),
    ),
    await import("../os/flow/flow.module.ts").then((m) => m.createForgeFlowModule()),
    await import("../os/system/system.module.ts").then((m) => m.createForgeSystemModule()),
    await import("../os/formal/formal.module.ts").then((m) => m.createForgeFormalModule()),
    await import("../os/friction/friction.module.ts").then((m) => m.createForgeFrictionModule()),
    await import("../os/yaml/yaml.module.ts").then((m) => m.createForgeYamlModule()),
    await import("../os/resolver/resolver.module.ts").then((m) => m.forgeResolverModule),
    await import("../os/instructions/instructions.module.ts").then(
      (m) => m.forgeInstructionsModule,
    ),
    await import("../os/agent/agent.module.ts").then((m) => m.forgeAgentModule),
    await import("../os/knowledge/knowledge.module.ts").then((m) => m.forgeKnowledgeModule),
    await import("../os/gate/gate.module.ts").then((m) => m.forgeGateModule),
    await import("../os/checks/checks.module.ts").then((m) => m.forgeChecksModule),
    await import("../os/context/context.module.ts").then((m) => m.forgeContextModule),
    await import("../os/trajectory/trajectory.module.ts").then((m) => m.forgeTrajectoryModule),
  ].filter((m): m is ForgeModule => m !== null);

  for (const mod of modules) {
    for (const cmd of mod.commands) {
      registry.registerCommand(cmd);
    }
    for (const pipe of mod.pipelines) {
      registry.registerPipeline(pipe.name, pipe.steps);
    }
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
    // pkg-health-10: candidates probe bin/ and dist/bin/ layouts — in extract ../.. lands on the package root
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
    // pkg-health-10: candidates probe bin/ and dist/bin/ layouts — in extract ../.. lands on the package root
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

/**
 * ADR-0129 (F-0187): `forge run <cmd>` and bare kernel-command names get a
 * pointer to the workshop host instead of a bare "Unknown command". Fires
 * only when `docs/command-manifest.generated.yaml` exists and lists the
 * name — forge-only consumer repos (no manifest) keep the old output.
 */
function kernelCommandHint(commandName: string, workspaceRoot: string): string | undefined {
  const hint = "Kernel commands run through the workshop host: pnpm exec werkstatt run <cmd>";
  if (commandName === "run") return hint;
  try {
    const manifest = readFileSync(
      join(workspaceRoot, "docs/command-manifest.generated.yaml"),
      "utf8",
    );
    if (
      new RegExp(
        `^\\s*- name: ${commandName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
        "m",
      ).test(manifest)
    ) {
      return hint;
    }
  } catch {
    // no manifest — unchanged output
  }
  return undefined;
}

function printCommandHelp(registry: ForgeCliRegistry, commandName: string): void {
  const resolved = resolveCommandName(commandName, registry);
  const cmd = resolved ? registry.getCommand(resolved) : undefined;
  if (!resolved || !cmd) {
    logger.error(`Unknown command: ${commandName}`);
    const hint = kernelCommandHint(commandName, process.cwd());
    if (hint) logger.info(hint);
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
  const qualified = "forge." + commandName;
  if (registry.getCommand(qualified)) {
    return qualified;
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

  const registry = await buildRegistry();
  const resolved = resolveCommandName(commandName, registry);
  const command = resolved ? registry.getCommand(resolved) : undefined;

  if (!command) {
    logger.error(`Unknown command: ${commandName}`);
    const hint = kernelCommandHint(commandName, process.cwd());
    if (hint) logger.info(hint);
    logger.info(`Run 'forge --help' for available commands.`);
    process.exit(1);
  }

  const { flags, diagnostics } = resolveCliFlags(rest, command);
  const flagErrors = diagnostics.filter((d) => d.severity === "error");
  if (flagErrors.length > 0) {
    logger.error(
      `[${command.name}] ${flagErrors.length} flag error${flagErrors.length === 1 ? "" : "s"}`,
    );
    for (const diagnostic of diagnostics) {
      logger.error(`  ${diagnostic.ruleId} · ${diagnostic.message}`);
      if (diagnostic.fixHint) {
        logger.error(`  fix: ${diagnostic.fixHint}`);
      }
    }
    process.exit(1);
  }

  if (flags["help"] === true) {
    printCommandHelp(registry, commandName);
    return;
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
