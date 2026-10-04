/*
<MODULE_CONTRACT>
<purpose>Argv-to-flags resolution for the standalone forge CLI — a standalone
port of the kernel's RFC-0260 semantics (resolveCommandFlags for schema-carrying
commands, the heuristic parser for schema-less ones). Ensures a declared string
flag never reaches a handler as `true`, which crashed `forge rfc.validate --id`
with `TypeError: targetId.toLowerCase is not a function`.</purpose>
<non-goals>
  <item>Do not import from @warpgogol/* — forge is autonomous (FORGE-AUTONOMY-01); keep this a self-contained port.</item>
  <item>Do not call console.* or process.exit — bin/cli.ts renders diagnostics and decides the exit code.</item>
</non-goals>
</MODULE_CONTRACT>
<CHANGE_SUMMARY>
  <item>Standalone port of kernel argv resolution for the forge CLI (RFC-0260 lineage): strict KERNEL-FLAG-01/02/03 + KERNEL-ARG-01 diagnostics for schema-carrying commands, legacy heuristic parse (with KERNEL-ARG-01) for schema-less commands; repeated single-value string flags diagnose instead of silently promoting to an array that crashes handlers; indexOf-based inline-value split preserves values containing "=" that split("=", 2) silently truncated.</item>
</CHANGE_SUMMARY>
*/

import type { Diagnostic, ForgeCommandDefinition, ForgeFlagSpec, ForgeFlagValue } from "./types.ts";

/**
 * Flags every CLI command accepts regardless of its own declared schema —
 * mirrors the kernel's KERNEL_UNIVERSAL_FLAGS so both entry points accept the
 * same universal switches.
 */
export const CLI_UNIVERSAL_FLAGS: Record<string, ForgeFlagSpec> = {
  site: { kind: "string", description: "Target a specific site by name." },
  all: { kind: "boolean", description: "Run against every discovered app." },
  json: { kind: "boolean", description: "Emit machine-readable JSON instead of pretty output." },
  quiet: { kind: "boolean", description: "Suppress non-essential log output." },
  verbose: { kind: "boolean", description: "Emit additional diagnostic log output." },
  root: { kind: "string", description: "Override the resolved workspace root." },
  "dry-run": { kind: "boolean", description: "Report intended mutations without writing them." },
  force: { kind: "boolean", description: "Bypass a normally-blocking safety check." },
  help: { kind: "boolean", description: "Print command help instead of executing." },
};

/**
 * Boolean switches for the legacy heuristic path (schema-less commands).
 * Mirrors the kernel's KERNEL_BOOLEAN_FLAGS: a listed flag never consumes the
 * following token as its value.
 */
const CLI_BOOLEAN_FLAGS = new Set<string>([
  "all",
  "all-apps",
  "approve-all",
  "dry-run",
  "force",
  "help",
  "inplace",
  "json",
  "mini",
  "packages",
  "page",
  "prod",
  "quiet",
  "regen",
  "regenerate",
  "report-only",
  "show-versions",
  "strict",
  "verbose",
  "version",
  "write",
]);

function addFlagValue(
  target: Record<string, ForgeFlagValue>,
  key: string,
  value: string | boolean,
): void {
  const existing = target[key];

  if (existing === undefined) {
    target[key] = value;
    return;
  }

  if (Array.isArray(existing)) {
    if (typeof value === "string") {
      target[key] = [...existing, value];
    }
    return;
  }

  if (typeof existing === "string") {
    if (typeof value === "string") {
      target[key] = [existing, value];
      return;
    }

    target[key] = existing;
    return;
  }

  target[key] = value;
}

function positionalDiagnostic(entry: string, commandName?: string): Diagnostic {
  const scope = commandName ? ` for command "${commandName}"` : "";
  return {
    ruleId: "KERNEL-ARG-01",
    severity: "error",
    message: `Unexpected positional argument "${entry}"${scope}. All arguments must be passed as flags.`,
    fixHint: `Convert "${entry}" to a flag, e.g. --id ${entry}.`,
  };
}

/**
 * Legacy heuristic parse for commands without a `flags` schema — mirrors the
 * kernel's parseKernelArgv: unknown flags are accepted, boolean-ness comes
 * from CLI_BOOLEAN_FLAGS, and positional tokens produce KERNEL-ARG-01.
 */
export function parseCliArgs(argv: string[]): {
  flags: Record<string, ForgeFlagValue>;
  diagnostics: Diagnostic[];
} {
  const flags: Record<string, ForgeFlagValue> = {};
  const diagnostics: Diagnostic[] = [];
  let passthrough = false;

  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index]!;

    if (passthrough) {
      diagnostics.push(positionalDiagnostic(entry));
      continue;
    }

    if (entry === "--") {
      passthrough = true;
      continue;
    }

    if (!entry.startsWith("--")) {
      diagnostics.push(positionalDiagnostic(entry));
      continue;
    }

    const withoutPrefix = entry.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const flagName = eqIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : withoutPrefix.slice(eqIndex + 1);
    if (!flagName) continue;

    if (inlineValue !== undefined) {
      addFlagValue(flags, flagName, inlineValue);
      continue;
    }

    if (CLI_BOOLEAN_FLAGS.has(flagName)) {
      addFlagValue(flags, flagName, true);
      continue;
    }

    const next = argv[index + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      addFlagValue(flags, flagName, next);
      index += 1;
      continue;
    }

    addFlagValue(flags, flagName, true);
  }

  return { flags, diagnostics };
}

function resolveStrict(
  rawArgv: string[],
  command: ForgeCommandDefinition,
): { flags: Record<string, ForgeFlagValue>; diagnostics: Diagnostic[] } {
  const schema: Record<string, ForgeFlagSpec> = {
    ...CLI_UNIVERSAL_FLAGS,
    ...(command.flags ?? {}),
  };
  const validFlagNames = Object.keys(schema).sort();
  const flags: Record<string, ForgeFlagValue> = {};
  const diagnostics: Diagnostic[] = [];
  let passthrough = false;

  for (let index = 0; index < rawArgv.length; index += 1) {
    const entry = rawArgv[index]!;

    if (passthrough) {
      diagnostics.push(positionalDiagnostic(entry, command.name));
      continue;
    }

    if (entry === "--") {
      passthrough = true;
      continue;
    }

    if (!entry.startsWith("--")) {
      diagnostics.push(positionalDiagnostic(entry, command.name));
      continue;
    }

    const withoutPrefix = entry.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    const flagName = eqIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : withoutPrefix.slice(eqIndex + 1);
    if (!flagName) continue;

    const spec = schema[flagName];
    if (!spec) {
      diagnostics.push({
        ruleId: "KERNEL-FLAG-01",
        severity: "error",
        message: `Unknown flag "--${flagName}" for command "${command.name}". Valid flags: ${validFlagNames.join(", ")}`,
        fixHint: `Remove --${flagName}, fix the typo, or add it to the flags schema for ${command.name}.`,
      });
      continue;
    }

    if (inlineValue !== undefined) {
      addFlagValue(
        flags,
        flagName,
        spec.kind === "boolean" ? inlineValue !== "false" : inlineValue,
      );
      continue;
    }

    if (spec.kind === "boolean") {
      addFlagValue(flags, flagName, true);
      continue;
    }

    const next = rawArgv[index + 1];
    if (typeof next === "string" && !next.startsWith("--")) {
      addFlagValue(flags, flagName, next);
      index += 1;
      continue;
    }

    diagnostics.push({
      ruleId: "KERNEL-FLAG-02",
      severity: "error",
      message: `Flag "--${flagName}" for command "${command.name}" requires a value but none was given.`,
      fixHint: `Pass --${flagName} <value> or --${flagName}=<value>.`,
    });
  }

  for (const [flagName, spec] of Object.entries(schema)) {
    const value = flags[flagName];
    if (spec.required && value === undefined) {
      diagnostics.push({
        ruleId: "KERNEL-FLAG-03",
        severity: "error",
        message: `Required flag "--${flagName}" is missing for command "${command.name}".`,
        fixHint: `Pass --${flagName} <value>.`,
      });
    } else if (value === undefined && spec.default !== undefined) {
      flags[flagName] = spec.default;
    } else if (spec.kind === "string" && Array.isArray(value)) {
      diagnostics.push({
        ruleId: "KERNEL-FLAG-02",
        severity: "error",
        message: `Flag "--${flagName}" for command "${command.name}" accepts a single value but was given multiple.`,
        fixHint: `Pass --${flagName} once, or declare the flag as kind "string[]" if multiple values are intended.`,
      });
    }
  }

  return { flags, diagnostics };
}

/**
 * Resolve raw argv against a command's declared flag schema (merged with
 * CLI_UNIVERSAL_FLAGS) — the standalone-CLI counterpart of the kernel's
 * resolveCommandFlags. Schema-carrying commands (`command.flags` set,
 * including `{}`) resolve strictly; schema-less commands keep the legacy
 * heuristic parse. Either way, positional tokens produce KERNEL-ARG-01.
 */
export function resolveCliFlags(
  argv: string[],
  command: ForgeCommandDefinition,
): { flags: Record<string, ForgeFlagValue>; diagnostics: Diagnostic[] } {
  if (command.flags) {
    return resolveStrict(argv, command);
  }
  return parseCliArgs(argv);
}
