/*
<MODULE_CONTRACT>
<purpose>
Plugin-CLI bridge (Werkstatt RFC-1648) — consumer plugins discovered from the
workspace forge.yaml `plugins:` entries load through the standard SDK loader and
their commands adapt into the CLI registry as first-class commands. One species:
npm-published and project-local plugins take the identical path. A plugin failing
any load phase is entirely absent — partial activation impossible — and the load
failure surfaces as a loud CLI diagnostic, never silent absence.
</purpose>
<non-goals><item>No compile cache — plugins ship compiled dist per RFC-1648.</item></non-goals>
<CHANGE_SUMMARY><item>WP-5/WP-6: initial bridge.</item></CHANGE_SUMMARY>
*/

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";

import type { ForgeCommandDefinition, ForgeCommandInput, ForgeCommandResult, ForgeRuntimeContext } from "../types.ts";
import { loadPlugin, type LoadedPlugin } from "./loader.ts";
import type { CommandModule, PluginContext } from "./types.ts";

/** Read consumer plugin entries from forge.yaml — absent section means no plugins. */
export function discoverPluginEntries(workspaceRoot: string): string[] {
  const configPath = join(workspaceRoot, "forge.yaml");
  if (!existsSync(configPath)) return [];
  try {
    const config = parseYaml(readFileSync(configPath, "utf8")) as { plugins?: unknown };
    if (!config.plugins) return [];
    if (Array.isArray(config.plugins)) return config.plugins.filter((p): p is string => typeof p === "string");
    if (typeof config.plugins === "object") return Object.keys(config.plugins);
    return [];
  } catch {
    return [];
  }
}

/** Adapt one SDK command into the CLI registry shape. */
export function adaptCommand(cmd: CommandModule, ctx: PluginContext, pluginId: string): ForgeCommandDefinition {
  return {
    name: cmd.id,
    description: `[${pluginId}] ${cmd.description}`,
    scope: "workspace",
    async execute(input: ForgeCommandInput, _runtime: ForgeRuntimeContext): Promise<ForgeCommandResult> {
      const args = (input.flags ?? {}) as Record<string, unknown>;
      try {
        const result = await cmd.run(ctx, args);
        const diagnostics = (result.violations ?? []).map((v) => ({
          ruleId: v.ruleId,
          severity: v.severity === "blocking" ? ("error" as const) : ("warning" as const),
          message: v.message,
          file: v.file,
        }));
        return {
          data: { status: result.status, violations: result.violations, ...result.data },
          summary: result.message ?? `${cmd.id}: ${result.status}`,
          exitCode: result.status === "pass" ? 0 : 1,
          diagnostics,
        } as ForgeCommandResult;
      } catch (err) {
        return {
          summary: `${cmd.id}: executor error — ${err instanceof Error ? err.message : String(err)}`,
          exitCode: 1,
        };
      }
    },
  };
}

export interface PluginLoadReport {
  loaded: Array<{ pluginId: string; commands: string[] }>;
  failed: Array<{ entry: string; error: string }>;
}

/**
 * Discover and load all consumer plugins — fail-closed per plugin, but one
 * plugin's failure never blocks the others (each failure is reported loudly).
 */
export async function loadConsumerPlugins(workspaceRoot: string): Promise<{ plugins: LoadedPlugin[]; report: PluginLoadReport }> {
  const entries = discoverPluginEntries(workspaceRoot);
  const plugins: LoadedPlugin[] = [];
  const report: PluginLoadReport = { loaded: [], failed: [] };
  for (const entry of entries) {
    try {
      const loaded = await loadPlugin(entry, workspaceRoot, { workspaceRoot });
      plugins.push(loaded);
      report.loaded.push({ pluginId: loaded.manifest.id, commands: loaded.commands.map((c) => c.id) });
    } catch (err) {
      report.failed.push({ entry, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { plugins, report };
}
